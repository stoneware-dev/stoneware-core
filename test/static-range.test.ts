/**
 * Range requests and conditional requests on static files.
 *
 * These go over real HTTP rather than `app.fetch()`, which is unlike the rest of
 * the suite and is the whole point. Bun answers `Range` on a `Bun.file()` body
 * as it writes the response out — after the framework has returned. An
 * in-process `app.fetch()` never reaches that code, so a test written the usual
 * way here would assert nothing and pass forever.
 *
 * Two layers now decide what a client gets back: `isFresh` in this repo, and
 * Bun's own range handling underneath it. They cannot disagree, because a 304
 * from `isFresh` carries no file body and so leaves Bun nothing to slice, and
 * when it does not fire the body goes out untouched. That boundary is held in
 * place by the runtime rather than by anything here, which is exactly why it is
 * worth pinning: it can move without a line of this project changing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { serve } from "../src/http/server.ts";
import { buildIslands } from "../src/build/build.ts";
import { discoverIslands } from "../src/build/islands.ts";

const ROOT = join(tmpdir(), `stoneware-static-range-${Date.now()}`);
const PUBLIC = join(ROOT, "public");
const ROUTES = join(ROOT, "routes");
// Inside the repo rather than beside the fixture in the temp directory: the
// generated island entries import "stoneware/client", so the build only
// resolves where the project's own module resolution applies.
const OUT_DIR = join(import.meta.dir, "..", ".static-range-test");

/** 26 bytes, so an offset in a failure message reads as a letter. */
const BODY = "abcdefghijklmnopqrstuvwxyz";

// High and arbitrary, clear of the range listen.test.ts walks.
const PORT = 4991;
const base = `http://localhost:${PORT}`;

let server: { stop(force?: boolean): void };
/** `/_stoneware/<hash>.js` — a content-hashed chunk, served immutable. */
let chunkPath = "";
let savedPort: string | undefined;

beforeAll(async () => {
  // PORT outranks the port passed here (config.ts:383), which is correct for a
  // deploy target and wrong for a test that has to know where to send requests.
  // Another file in this suite sets it and does not put it back, so whether
  // this one passes would otherwise depend on the order the files ran in.
  savedPort = Bun.env.PORT;
  delete Bun.env.PORT;

  mkdirSync(PUBLIC, { recursive: true });
  mkdirSync(ROUTES, { recursive: true });
  writeFileSync(join(PUBLIC, "asset.txt"), BODY);
  writeFileSync(
    join(ROUTES, "index.tsx"),
    `export default function Home() { return <main>hi</main>; }`,
  );

  // Real chunks rather than a hand-written file: the immutable branch is
  // reached by path prefix, and a fake one under public/ would take the
  // revalidated branch instead and quietly test the wrong thing.
  const islands = await discoverIslands(join(import.meta.dir, "fixture", "islands"));
  const { manifest } = await buildIslands({ islands, outDir: OUT_DIR, dev: false });
  chunkPath = Object.values(manifest)[0]!;

  ({ server } = await serve(
    {
      root: ROOT,
      publicDir: PUBLIC,
      routesDir: ROUTES,
      outDir: OUT_DIR,
      port: PORT,
      csrf: { secret: "static-range-test-secret-not-a-real-one" },
    },
    // An empty manifest, deliberately: the chunk route is reached by path
    // prefix alone, and registering islands nothing renders only produces a
    // "built but not registered" warning in the suite output.
    { dev: false, islandManifest: {}, stylesheet: null },
  ));
});

afterAll(() => {
  server?.stop(true);
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(OUT_DIR, { recursive: true, force: true });

  if (savedPort === undefined) delete Bun.env.PORT;
  else Bun.env.PORT = savedPort;
});

const get = (path: string, headers?: HeadersInit) => fetch(base + path, { headers });

describe("a file in public/", () => {
  test("serves the whole file with a validator", async () => {
    const res = await get("/asset.txt");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
    expect(res.headers.get("etag")).toMatch(/^W\//);
    expect(res.headers.get("last-modified")).not.toBeNull();
  });

  test("answers a range with only the requested bytes", async () => {
    const res = await get("/asset.txt", { Range: "bytes=0-4" });

    expect(res.status).toBe(206);
    expect(await res.text()).toBe("abcde");
    expect(res.headers.get("content-range")).toBe(`bytes 0-4/${BODY.length}`);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  test("answers an open-ended range", async () => {
    const res = await get("/asset.txt", { Range: "bytes=5-" });

    expect(res.status).toBe(206);
    expect(await res.text()).toBe(BODY.slice(5));
    expect(res.headers.get("content-range")).toBe(`bytes 5-25/${BODY.length}`);
  });

  test("refuses a range past the end of the file", async () => {
    const res = await get("/asset.txt", { Range: "bytes=999999-" });

    // 416 must carry the real length, or a client cannot correct its request.
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${BODY.length}`);
  });

  test("returns 304 for a matching validator", async () => {
    const etag = (await get("/asset.txt")).headers.get("etag")!;
    const res = await get("/asset.txt", { "If-None-Match": etag });

    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  test("returns the body for a stale validator", async () => {
    const res = await get("/asset.txt", { "If-None-Match": 'W/"not-the-current-one"' });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(BODY);
  });

  test("prefers the precondition over the range", async () => {
    // RFC 9110 §13.1.2: a client that already holds the bytes gets 304, not a
    // slice of what it has. This is the one request both layers could answer,
    // and the 304 wins because it leaves no file body to range.
    const etag = (await get("/asset.txt")).headers.get("etag")!;
    const res = await get("/asset.txt", { "If-None-Match": etag, Range: "bytes=0-4" });

    expect(res.status).toBe(304);
    expect(res.headers.get("content-range")).toBeNull();
  });

  test("returns 304 for If-Modified-Since", async () => {
    const lastModified = (await get("/asset.txt")).headers.get("last-modified")!;
    const res = await get("/asset.txt", { "If-Modified-Since": lastModified });

    expect(res.status).toBe(304);
  });

  test("keeps the security headers on a partial response", async () => {
    // Bun rebuilds the status line and the framing to make a 206. Nothing about
    // that should reach the headers this framework guarantees — a partial
    // response is still a response, and an asset served without its CSP or
    // nosniff is the failure this asserts against.
    const res = await get("/asset.txt", { Range: "bytes=0-4" });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-security-policy")).not.toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });
});

describe("a content-hashed chunk", () => {
  test("is cached for a year without a validator", async () => {
    const res = await get(chunkPath);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    // Nothing to revalidate against, by design: the name changes when the bytes
    // do, so there is no version of this URL that could go stale.
    expect(res.headers.get("etag")).toBeNull();
  });

  test("answers a range even though it carries no validator", async () => {
    const whole = await (await get(chunkPath)).text();
    const res = await get(chunkPath, { Range: "bytes=0-9" });

    expect(res.status).toBe(206);
    expect(await res.text()).toBe(whole.slice(0, 10));
    expect(res.headers.get("content-range")).toBe(`bytes 0-9/${whole.length}`);
  });
});
