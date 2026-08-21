/**
 * Running one server per core, behind a shared port.
 *
 * A single `Bun.serve` uses one core. On a twelve-core box that leaves eleven
 * idle while the twelfth saturates, and no amount of work inside the framework
 * changes it — the request path was measured at 0.07ms against roughly 0.9ms of
 * HTTP handling, so the ceiling is the runtime's, not the framework's.
 *
 * The fix is `SO_REUSEPORT`: several processes bind the same port and the
 * kernel spreads incoming connections across them.
 *
 * ## Why this is Linux-only
 *
 * `reusePort` is accepted by `Bun.serve` on every platform, and on two of them
 * it does not do what the name suggests:
 *
 *   Linux    the kernel load-balances accepts across every bound socket. This
 *            is the case the option exists for.
 *   Windows  verified on 1.3.14: both processes bind without error and the
 *            first one to bind receives *every* connection. Thirty requests,
 *            thirty answered by worker A.
 *   macOS    BSD semantics deliver to the most recent binder rather than
 *            balancing, so the same shape of problem.
 *
 * Clustering on those platforms would start N processes, take N times the
 * memory, serve everything from one of them, and report success. That is a
 * worse outcome than not clustering, and it is invisible — so the count is
 * forced to 1 off Linux and the reason is printed rather than swallowed.
 *
 * ## What a worker does not get
 *
 * Nothing is shared between workers. Anything a request handler keeps in a
 * module-level variable — a counter, a cache, a rate-limit tally — becomes one
 * copy per worker, and consecutive requests from the same visitor may land on
 * different ones. The CSRF secret is unaffected because it comes from the
 * environment and is therefore identical in every worker, which is exactly why
 * it has to keep coming from there.
 */

import { cpus } from "node:os";

/** Set in a spawned worker so it serves without spawning workers of its own. */
export const WORKER_ENV = "STONEWARE_WORKER_ID";

/** True when this process was started by a primary rather than by a person. */
export function isWorker(): boolean {
  return Bun.env[WORKER_ENV] !== undefined;
}

/**
 * Platforms where `SO_REUSEPORT` actually distributes connections.
 *
 * A list of one, deliberately written as a list: the next platform to be added
 * should be added on evidence, and the comment above records what the evidence
 * was for the two that are excluded.
 */
const BALANCING_PLATFORMS: readonly string[] = ["linux"];

export interface WorkerCountInput {
  /** `workers` from the resolved config. */
  configured: number | "auto";
  dev: boolean;
  platform: string;
  cpuCount: number;
  /** Collects anything the operator needs to know. */
  warn?: (message: string) => void;
}

/**
 * How many processes should serve, given what was asked for and what the
 * platform can actually deliver.
 *
 * Separate from the spawning so the decision can be tested without starting
 * anything: the interesting cases are all refusals, and a refusal that silently
 * became an acceptance is the bug this file exists to avoid.
 */
export function resolveWorkerCount(input: WorkerCountInput): number {
  const { configured, dev, platform, cpuCount } = input;
  const warn = input.warn ?? ((message: string) => console.warn(message));

  const asked = configured === "auto" ? Math.max(1, cpuCount) : configured;

  if (!Number.isInteger(asked) || asked < 1) {
    throw new TypeError(
      `workers must be a positive integer or "auto", not ${JSON.stringify(configured)}.`,
    );
  }

  if (asked === 1) return 1;

  // The dev server watches files, rebuilds islands and holds a live-reload
  // socket. Several copies would each rebuild on every save and the browser
  // would reconnect to whichever one it reached.
  if (dev) {
    warn(`[stoneware] workers is ignored in development; running a single process.`);
    return 1;
  }

  if (!BALANCING_PLATFORMS.includes(platform)) {
    warn(
      `[stoneware] workers: ${asked} was requested, but ${platform} does not load-balance a ` +
        `shared port — every connection would go to one process.\n` +
        `  Running a single process instead. Multi-process serving needs Linux.`,
    );
    return 1;
  }

  return asked;
}

export interface SuperviseOptions {
  /** Total processes serving, including the primary. Must be at least 2. */
  workers: number;
  /** Overridable for tests. */
  spawn?: (env: Record<string, string>) => WorkerHandle;
  log?: (message: string) => void;
}

export interface WorkerHandle {
  pid: number | undefined;
  kill(): void;
  /** Resolves with the exit code when the process ends. */
  exited: Promise<number>;
}

/**
 * A worker that died more than this many times inside the window is not
 * restarted again. A process that crashes on startup would otherwise be
 * respawned forever, turning one bad deploy into a fork bomb.
 */
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10_000;

export interface Supervisor {
  /** Stop every worker. Idempotent. */
  stop(): void;
  /** Live worker handles, for tests. */
  readonly workers: readonly WorkerHandle[];
}

/**
 * Start and keep alive `workers - 1` additional processes.
 *
 * The primary serves too rather than only supervising: it has already bound the
 * port and built the app, and a process that does nothing but watch others is a
 * whole core spent on bookkeeping.
 *
 * Workers are not restarted after `stop()`, so a deliberate shutdown does not
 * race the restart logic into bringing one back.
 */
export function supervise(options: SuperviseOptions): Supervisor {
  const log = options.log ?? ((message: string) => console.warn(message));
  const spawn = options.spawn ?? defaultSpawn;

  const count = options.workers - 1;
  const workers: WorkerHandle[] = [];
  const restarts: number[] = [];
  let stopping = false;

  const start = (index: number) => {
    const handle = spawn({ [WORKER_ENV]: String(index) });
    workers[index] = handle;

    void handle.exited.then((code) => {
      if (stopping) return;

      const now = Date.now();
      while (restarts.length > 0 && now - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
      restarts.push(now);

      if (restarts.length > MAX_RESTARTS) {
        log(
          `[stoneware] worker ${index} exited with code ${code}, and workers have restarted ` +
            `${restarts.length} times in ${RESTART_WINDOW_MS / 1000}s. Not restarting again — ` +
            `the primary keeps serving alone.`,
        );
        return;
      }

      log(`[stoneware] worker ${index} exited with code ${code}; restarting.`);
      start(index);
    });
  };

  for (let index = 1; index <= count; index++) start(index);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    for (const worker of workers) worker?.kill();
  };

  // A worker outliving its primary would keep the port bound and keep serving
  // a build nobody is supervising. These cover an orderly exit; a SIGKILL of
  // the primary cannot be intercepted, and there the process manager (systemd,
  // Docker, a container runtime) kills the group.
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  process.on("exit", stop);

  return {
    stop,
    get workers() {
      return workers.filter((worker) => worker !== undefined);
    },
  };
}

/**
 * Re-run this same command with the worker marker set.
 *
 * `process.argv` rather than a rebuilt command line: whatever started the
 * primary — `stoneware start`, a bundled server, a custom entry point — is what
 * should start the worker, and reconstructing it would be a second definition
 * of how the server boots.
 */
function defaultSpawn(env: Record<string, string>): WorkerHandle {
  const child = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
    env: { ...process.env, ...env },
    // Inherited so a worker's logs land where the primary's do. A worker that
    // crashes with its output swallowed is a worker nobody can debug.
    stdio: ["ignore", "inherit", "inherit"],
  });

  return {
    pid: child.pid,
    kill: () => child.kill(),
    exited: child.exited,
  };
}
