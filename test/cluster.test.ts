/**
 * Multi-process serving.
 *
 * The decision matters more than the mechanism here. `reusePort` is accepted by
 * `Bun.serve` on every platform and only load-balances on Linux — verified on
 * Windows 1.3.14, where two processes bound the same port without error and the
 * first one answered all thirty test requests. Clustering there would take N
 * times the memory, serve from one process, and report success.
 *
 * So most of these tests are about refusing, and about saying why.
 */

import { describe, expect, test } from "bun:test";

import { WORKER_ENV, isWorker, resolveWorkerCount, supervise } from "../src/http/cluster.ts";
import type { WorkerHandle } from "../src/http/cluster.ts";

const base = { dev: false, platform: "linux", cpuCount: 8 };

const collect = () => {
  const messages: string[] = [];
  return { messages, warn: (m: string) => messages.push(m) };
};

describe("resolveWorkerCount", () => {
  test("defaults to a single process", () => {
    expect(resolveWorkerCount({ ...base, configured: 1 })).toBe(1);
  });

  test('"auto" is one per core on Linux', () => {
    expect(resolveWorkerCount({ ...base, configured: "auto", cpuCount: 12 })).toBe(12);
  });

  test("an explicit count is honoured on Linux", () => {
    expect(resolveWorkerCount({ ...base, configured: 4 })).toBe(4);
  });

  test("a machine reporting no cores still gets one process", () => {
    expect(resolveWorkerCount({ ...base, configured: "auto", cpuCount: 0 })).toBe(1);
  });

  describe("platforms where a shared port does not balance", () => {
    for (const platform of ["win32", "darwin", "freebsd"]) {
      test(`${platform} is forced to one process, with a reason`, () => {
        const { messages, warn } = collect();
        const count = resolveWorkerCount({ ...base, platform, configured: 8, warn });

        expect(count).toBe(1);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain(platform);
        expect(messages[0]).toContain("Linux");
      });
    }

    test("asking for one process on Windows warns about nothing", () => {
      // Nothing was refused, so there is nothing to report.
      const { messages, warn } = collect();
      expect(resolveWorkerCount({ ...base, platform: "win32", configured: 1, warn })).toBe(1);
      expect(messages).toHaveLength(0);
    });
  });

  describe("development", () => {
    test("never clusters, whatever the platform", () => {
      const { messages, warn } = collect();
      const count = resolveWorkerCount({ ...base, dev: true, configured: 8, warn });

      expect(count).toBe(1);
      expect(messages[0]).toContain("development");
    });
  });

  describe("bad input", () => {
    for (const configured of [0, -2, 1.5, Number.NaN]) {
      test(`${configured} is refused rather than coerced`, () => {
        expect(() => resolveWorkerCount({ ...base, configured })).toThrow(/positive integer/i);
      });
    }
  });
});

describe("isWorker", () => {
  test("reads the marker the primary sets", () => {
    const before = Bun.env[WORKER_ENV];
    try {
      delete Bun.env[WORKER_ENV];
      expect(isWorker()).toBe(false);

      Bun.env[WORKER_ENV] = "3";
      expect(isWorker()).toBe(true);
    } finally {
      if (before === undefined) delete Bun.env[WORKER_ENV];
      else Bun.env[WORKER_ENV] = before;
    }
  });
});

/** A worker that never really runs, so supervision can be tested in isolation. */
function fakeWorker() {
  let resolveExit: (code: number) => void;
  const exited = new Promise<number>((resolve) => (resolveExit = resolve));
  let killed = false;

  return {
    handle: {
      pid: 1234,
      kill: () => {
        killed = true;
        resolveExit(0);
      },
      exited,
    } as WorkerHandle,
    die: (code: number) => resolveExit(code),
    wasKilled: () => killed,
  };
}

describe("supervise", () => {
  test("spawns one fewer process than the worker count, because the primary serves", () => {
    const spawned: Record<string, string>[] = [];
    const supervisor = supervise({
      workers: 4,
      log: () => {},
      spawn: (env) => {
        spawned.push(env);
        return fakeWorker().handle;
      },
    });

    expect(spawned).toHaveLength(3);
    expect(spawned.map((e) => e[WORKER_ENV])).toEqual(["1", "2", "3"]);
    supervisor.stop();
  });

  test("a worker that dies is replaced", async () => {
    const made: ReturnType<typeof fakeWorker>[] = [];
    const supervisor = supervise({
      workers: 2,
      log: () => {},
      spawn: () => {
        const worker = fakeWorker();
        made.push(worker);
        return worker.handle;
      },
    });

    expect(made).toHaveLength(1);
    made[0].die(1);
    await Bun.sleep(10);

    expect(made).toHaveLength(2);
    supervisor.stop();
  });

  test("a crash loop stops being restarted", async () => {
    // A worker that dies on startup would otherwise be respawned forever,
    // turning one bad deploy into a fork bomb.
    const made: ReturnType<typeof fakeWorker>[] = [];
    const logs: string[] = [];

    const supervisor = supervise({
      workers: 2,
      log: (m) => logs.push(m),
      spawn: () => {
        const worker = fakeWorker();
        made.push(worker);
        return worker.handle;
      },
    });

    for (let i = 0; i < 12; i++) {
      made[made.length - 1].die(1);
      await Bun.sleep(5);
    }

    expect(made.length).toBeLessThanOrEqual(7);
    expect(logs.some((m) => m.includes("Not restarting"))).toBe(true);
    supervisor.stop();
  });

  test("stop() kills every worker and does not restart them", async () => {
    const made: ReturnType<typeof fakeWorker>[] = [];
    const supervisor = supervise({
      workers: 3,
      log: () => {},
      spawn: () => {
        const worker = fakeWorker();
        made.push(worker);
        return worker.handle;
      },
    });

    supervisor.stop();
    await Bun.sleep(10);

    expect(made).toHaveLength(2);
    expect(made.every((w) => w.wasKilled())).toBe(true);
  });

  test("stop() is idempotent", () => {
    const supervisor = supervise({ workers: 2, log: () => {}, spawn: () => fakeWorker().handle });
    supervisor.stop();
    expect(() => supervisor.stop()).not.toThrow();
  });
});
