/**
 * What is streamed, what is not, and what happens when a client is slow.
 *
 * Streaming SSR is a stated non-goal (claude.md §3), so the first half of this
 * file pins the *absence* of a feature. That is deliberate. A page is rendered
 * to one complete string and sent with a Content-Length, and the ETag at
 * http/server.ts:609 is a hash of that whole document — so streaming a page could
 * not be added by accident without this failing first and forcing the decision
 * to be made on purpose.
 *
 * What does stream is a file body. Bun 1.4 pauses reading from disk when the
 * socket's send buffer fills, so a stalled client holds roughly one buffer of
 * server memory rather than the whole file. None of that is this project's
 * code, which is the reason to test it: it is behaviour the framework inherits
 * and would lose silently.
 *
 * These go over real HTTP. Backpressure and disconnects do not exist for an
 * in-process `app.fetch()`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { serve } from "../src/http/server.ts";

const FIXTURE_ROOT = join(import.meta.dir, "fixture");
const ROOT = join(tmpdir(), `stoneware-streaming-${Date.now()}`);
const PUBLIC = join(ROOT, "public");

/**
 * 16 MiB. Large enough that buffering it would be unmistakable in RSS, small
 * enough not to make the suite wait on the disk.
 */
const BIG_BYTES = 16 * 1024 * 1024;

/** Concurrent stalled readers. 16 × 16 MiB is 256 MB if anything buffers. */
const SLOW_CLIENTS = 16;

const PORT = 4993;
const base = `http://localhost:${PORT}`;

let server: { stop(force?: boolean): void };
let savedPort: string | undefined;

const rssMB = () => Math.round(process.memoryUsage.rss() / 1024 / 1024);

beforeAll(async () => {
  // PORT outranks a configured port (config.ts:383). Guarded here as well as
  // at the source, so this file does not depend on which others ran first.
  savedPort = Bun.env.PORT;
  delete Bun.env.PORT;

  mkdirSync(PUBLIC, { recursive: true });
  writeFileSync(join(PUBLIC, "big.bin"), Buffer.alloc(BIG_BYTES, "x"));

  // Routes come from the fixture rather than a generated temp file: the JSX
  // resolves "stoneware" by package self-reference, which only works for a file
  // inside this package.
  ({ server } = await serve(
    {
      root: FIXTURE_ROOT,
      publicDir: PUBLIC,
      routesDir: join(FIXTURE_ROOT, "routes"),
      port: PORT,
      csrf: { secret: "streaming-test-secret-not-a-real-one" },
    },
    { dev: false, islandManifest: {}, stylesheet: null },
  ));
});

afterAll(() => {
  server?.stop(true);
  rmSync(ROOT, { recursive: true, force: true });

  if (savedPort === undefined) delete Bun.env.PORT;
  else Bun.env.PORT = savedPort;
});

describe("a page is one complete document, not a stream", () => {
  test("is sent with a length rather than chunked", async () => {
    const res = await fetch(`${base}/plain`);
    const body = await res.text();

    expect(res.status).toBe(200);
    // A fixed Content-Length is the proof: the renderer knew the total size
    // before the first byte went out, which a streamed document cannot.
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(body)));
    expect(res.headers.get("transfer-encoding")).toBeNull();
  });

  test("carries a validator computed over the whole document", async () => {
    // Only possible because the document is complete before it is sent. If
    // pages ever stream, this is the assertion that has to be argued with.
    const res = await fetch(`${base}/plain`);

    expect(res.headers.get("etag")).toMatch(/^W\//);
  });
});

describe("a large file under a slow client", () => {
  test("does not buffer the file in memory for many stalled readers", async () => {
    const before = rssMB();

    // Each reader takes one chunk and then stops reading, leaving the socket's
    // send buffer full. Without backpressure the server races ahead and every
    // unsent byte lands on the heap.
    const readers = await Promise.all(
      Array.from({ length: SLOW_CLIENTS }, async () => {
        const res = await fetch(`${base}/big.bin`);
        const reader = res.body!.getReader();
        await reader.read();
        return reader;
      }),
    );

    await Bun.sleep(750);
    const stalled = rssMB() - before;

    // A coarse ceiling on purpose. Full buffering would be roughly
    // SLOW_CLIENTS × 16 MiB — 256 MB — so this has an order of magnitude of
    // headroom and is not a measurement of the allocator's mood.
    expect(stalled).toBeLessThan(96);

    for (const reader of readers) await reader.cancel();
  });

  test("survives a client that disconnects mid-download", async () => {
    const res = await fetch(`${base}/big.bin`);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();

    // The next request is the assertion: an abandoned transfer must not leave
    // the connection or the server in a state the following client inherits.
    const after = await fetch(`${base}/big.bin`, { headers: { Range: "bytes=0-9" } });
    expect(after.status).toBe(206);
    expect((await after.text()).length).toBe(10);
  });

  test("keeps its security headers on a streamed body", async () => {
    const res = await fetch(`${base}/big.bin`);

    expect(res.headers.get("content-security-policy")).not.toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    await res.body!.cancel();
  });
});
