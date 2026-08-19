/**
 * What `serve()` actually decides, with a real server on a real port.
 *
 * The unit tests cover `resolveWorkerCount` in isolation; this covers the wiring
 * around it. The case worth guarding hardest is a worker that clusters: each
 * spawned process would spawn its own set, and the count would grow as a power
 * rather than a sum. Nothing about that failure is gentle.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { serve } from "../src/server.ts";
import { WORKER_ENV } from "../src/cluster.ts";

const ROOT = join(tmpdir(), `stoneware-worker-serve-${Date.now()}`);
const SECRET = "worker-serve-test-secret";

let port = 4970;
const nextPort = () => port++;

const running: { server: { stop(force?: boolean): void }; supervisor: { stop(): void } | null }[] =
  [];

let savedPort: string | undefined;

beforeAll(() => {
  // PORT wins over an explicit config port, deliberately — that is how `--port`
  // beats stoneware.config.ts. Another test file sets it and does not restore
  // it, so without this every server here binds that file's port instead of
  // the one it asked for, and fails on a collision that has nothing to do with
  // workers.
  savedPort = Bun.env.PORT;
  delete Bun.env.PORT;

  // A plain handler rather than a JSX page: this fixture lives in the system
  // temp directory, where `stoneware/jsx-runtime` does not resolve. Nothing
  // here is testing rendering.
  mkdirSync(join(ROOT, "routes"), { recursive: true });
  writeFileSync(
    join(ROOT, "routes", "ping.ts"),
    `export function GET() { return new Response("ok"); }`,
  );
});

afterEach(() => {
  for (const entry of running.splice(0)) {
    entry.supervisor?.stop();
    entry.server.stop(true);
  }
});

afterAll(() => {
  if (savedPort === undefined) delete Bun.env.PORT;
  else Bun.env.PORT = savedPort;
  rmSync(ROOT, { recursive: true, force: true });
});

async function start(config: Record<string, unknown>, dev = false) {
  const result = await serve(
    { root: ROOT, port: nextPort(), hostname: "127.0.0.1", csrf: { secret: SECRET }, ...config },
    { dev, islandManifest: {}, stylesheet: null },
  );
  running.push(result);
  return result;
}

/** Run `fn` with the worker marker set, then restore it. */
async function asWorker<T>(fn: () => Promise<T>): Promise<T> {
  const before = Bun.env[WORKER_ENV];
  Bun.env[WORKER_ENV] = "2";
  try {
    return await fn();
  } finally {
    if (before === undefined) delete Bun.env[WORKER_ENV];
    else Bun.env[WORKER_ENV] = before;
  }
}

describe("a spawned worker", () => {
  test("never clusters, however many workers were configured", async () => {
    // Otherwise every worker spawns its own workers, and 4 becomes 16 becomes
    // 64 before anyone notices the machine is gone.
    const result = await asWorker(() => start({ workers: 8 }));

    expect(result.workers).toBe(1);
    expect(result.supervisor).toBeNull();
  });

  test("still serves normally", async () => {
    const result = await asWorker(() => start({ workers: 4 }));
    const response = await fetch(`http://127.0.0.1:${result.server.port}/ping`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});

describe("the primary", () => {
  test("defaults to a single process with no supervisor", async () => {
    const result = await start({});

    expect(result.workers).toBe(1);
    expect(result.supervisor).toBeNull();
  });

  test("workers: 1 is explicitly a single process", async () => {
    const result = await start({ workers: 1 });

    expect(result.workers).toBe(1);
    expect(result.supervisor).toBeNull();
  });

  test("development never clusters", async () => {
    const result = await start({ workers: 8 }, true);

    expect(result.workers).toBe(1);
    expect(result.supervisor).toBeNull();
  });

  test.skipIf(process.platform === "linux")(
    "falls back to one process where a shared port does not balance",
    async () => {
      // Skipped on Linux rather than branched, because there the call really
      // would cluster: `supervise` re-runs `process.argv`, which under the test
      // runner is `bun test` — so each worker would start the suite again.
      // Nothing here is worth spawning three recursive test runs for.
      //
      // The Linux side is covered where it can be observed properly: the
      // container matrix asserts process counts, request distribution across
      // workers, the banner, and shutdown, none of which a single-process test
      // can see. See cluster-tests/ in the benchmark repo.
      const result = await start({ workers: 4 });

      expect(result.workers).toBe(1);
      expect(result.supervisor).toBeNull();
    },
  );

  test("an invalid count fails at startup rather than silently serving", async () => {
    expect(start({ workers: 0 })).rejects.toThrow(/positive integer/i);
    expect(start({ workers: -3 })).rejects.toThrow(/positive integer/i);
    expect(start({ workers: 2.5 })).rejects.toThrow(/positive integer/i);
  });
});
