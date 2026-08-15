/**
 * Editing an island must not break the running dev server.
 *
 * `bun --hot` re-evaluates this CLI's own module graph whenever something it
 * imports changes, and an edit under `islands/` does exactly that. The dev
 * server used to respond by calling `Bun.serve` a second time: the previous
 * server stayed bound, the new one took the next free port, and the browser
 * carried on talking to a server built from the *previous* module graph.
 *
 * Values crossing between the two graphs then failed every identity check the
 * framework makes. `csrfToken()` read an `AsyncLocalStorage` that the running
 * server had never written to, so any page with a `<Form>` answered 500 with
 * "No active render context" - blaming the template. Each further edit stranded
 * another server on another port.
 *
 * This spawns the real CLI because nothing smaller reproduces it: the bug lives
 * in the interaction between `--hot` re-evaluation and a bound socket, and both
 * halves are real processes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixture");
const ROOT = join(import.meta.dir, "..", ".hot-reload-test");
const PORT = 4771;

/** Generous: a first start compiles the CLI, the fixture and the island chunks. */
const READY_TIMEOUT_MS = 30_000;
/** A rebuild is a debounce plus one Bun.build, but CI machines are not fast. */
const RELOAD_TIMEOUT_MS = 30_000;

let server: Bun.Subprocess | undefined;

interface Probe {
  up: boolean;
  status?: number;
  html?: string;
}

async function probe(port: number): Promise<Probe> {
  try {
    const response = await fetch(`http://localhost:${port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    return { up: true, status: response.status, html: await response.text() };
  } catch {
    return { up: false };
  }
}

/**
 * Poll until `accept` is satisfied, or give up and report what was last seen.
 *
 * `nudge` runs periodically, and exists because this suite runs alongside other
 * files doing their own `Bun.build`. Under that load Windows' recursive
 * `fs.watch` will drop an event, and the test would then be measuring watch
 * reliability rather than the thing it is about - whether the server survives
 * an island edit. Re-applying the edit cannot mask a regression: if the fix
 * were reverted the page would answer 500 however many times the file is
 * touched.
 */
async function until(
  label: string,
  accept: (probe: Probe) => boolean,
  timeoutMs: number,
  nudge?: () => Promise<void>,
): Promise<Probe> {
  const deadline = Date.now() + timeoutMs;
  let nextNudge = Date.now() + 6000;
  let last: Probe = { up: false };

  while (Date.now() < deadline) {
    last = await probe(PORT);
    if (accept(last)) return last;

    if (nudge && Date.now() > nextNudge) {
      nextNudge = Date.now() + 6000;
      await nudge();
    }
    await Bun.sleep(250);
  }

  throw new Error(
    `Timed out waiting for ${label} after ${timeoutMs}ms. ` +
      `Last response: ${last.up ? `${last.status}` : "no connection"}.`,
  );
}

beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  await cp(FIXTURE, ROOT, { recursive: true });
  await rm(join(ROOT, ".stoneware"), { recursive: true, force: true });

  server = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "..", "bin", "stoneware.mjs"),
      "dev",
      "--root",
      ROOT,
      "--port",
      String(PORT),
    ],
    {
      cwd: join(import.meta.dir, ".."),
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, STONEWARE_CSRF_SECRET: "hot-reload-test-0123456789" },
    },
  );

  await until("the dev server to start", (p) => p.up && p.status === 200, READY_TIMEOUT_MS);
}, READY_TIMEOUT_MS + 5000);

afterAll(async () => {
  server?.kill();
  await Bun.sleep(300);
  await rm(ROOT, { recursive: true, force: true });
});

describe("editing an island while the dev server runs", () => {
  test(
    "the same port keeps serving, with the edit applied",
    async () => {
      const before = await probe(PORT);
      expect(before.status).toBe(200);
      expect(before.html).toContain('data-stoneware-island="Counter"');

      // A visible change, so the page itself says when the reload landed -
      // islands are server-rendered for the initial HTML.
      const island = join(ROOT, "islands", "Counter.tsx");
      const source = await readFile(island, "utf8");
      await writeFile(island, source.replace("Clicked {count} times", "Pressed {count} times"));

      const after = await until(
        "the island edit to reach the page",
        (p) => p.up && p.html?.includes("Pressed") === true,
        RELOAD_TIMEOUT_MS,
        () => writeFile(island, source.replace("Clicked {count} times", "Pressed {count} times")),
      );

      // The regression: this used to be 500 on this port forever, because the
      // browser was talking to the previous graph's server.
      expect(after.status).toBe(200);
      expect(after.html).toContain('data-stoneware-island="Counter"');
    },
    RELOAD_TIMEOUT_MS + 10_000,
  );

  test("no second server was stranded on the next port", async () => {
    // One `Bun.serve` for the life of the process. A re-evaluation hands the
    // existing server a new handler rather than binding again, so there is
    // nothing on the next port and the open live-reload sockets survive.
    for (const port of [PORT + 1, PORT + 2]) {
      expect((await probe(port)).up).toBe(false);
    }
  });

  test("a second edit behaves the same as the first", async () => {
    // The old failure compounded: every edit stranded one more server.
    const island = join(ROOT, "islands", "Counter.tsx");
    const source = await readFile(island, "utf8");
    await writeFile(island, source.replace("Pressed {count} times", "Tapped {count} times"));

    const after = await until(
      "the second island edit to reach the page",
      (p) => p.up && p.html?.includes("Tapped") === true,
      RELOAD_TIMEOUT_MS,
      () => writeFile(island, source.replace("Pressed {count} times", "Tapped {count} times")),
    );

    expect(after.status).toBe(200);
    expect((await probe(PORT + 1)).up).toBe(false);
  }, RELOAD_TIMEOUT_MS + 10_000);
});
