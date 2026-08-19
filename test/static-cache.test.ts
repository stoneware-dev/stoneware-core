/**
 * Metadata remembered after a file is served once.
 *
 * Serving an asset cost four filesystem round trips — the existence check in
 * safeJoin, the link check, `file.exists()`, then size and mtime for the
 * validator. Measured over HTTP that made serving a stylesheet slower than
 * rendering a whole page. These tests pin the behaviour the cache must keep:
 * identical headers on the second request as on the first, revalidation still
 * working, and no caching at all in dev, where files change under the server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createApp } from "../src/server.ts";

const ROOT = join(tmpdir(), `stoneware-static-cache-${Date.now()}`);
const PUBLIC = join(ROOT, "public");
const ROUTES = join(ROOT, "routes");

const SECRET = "static-cache-test-secret-not-a-real-one";

beforeAll(() => {
  mkdirSync(PUBLIC, { recursive: true });
  mkdirSync(ROUTES, { recursive: true });
  writeFileSync(join(PUBLIC, "styles.css"), "body{color:red}");
  writeFileSync(
    join(ROUTES, "index.tsx"),
    `export default function Home() { return <main>hi</main>; }`,
  );
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const app = (dev: boolean) =>
  createApp(
    { root: ROOT, publicDir: PUBLIC, routesDir: ROUTES, csrf: { secret: SECRET } },
    // The manifest is supplied rather than read: a production server refuses to
    // build islands at runtime, and this fixture has none to build.
    { dev, islandManifest: {}, stylesheet: null },
  );

const get = (a: Awaited<ReturnType<typeof createApp>>, path: string, headers?: HeadersInit) =>
  a.fetch(new Request(`http://localhost${path}`, { headers }));

describe("production", () => {
  test("a repeated request answers identically", async () => {
    const server = await app(false);

    const first = await get(server, "/styles.css");
    const second = await get(server, "/styles.css");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("ETag")).toBe(first.headers.get("ETag"));
    expect(second.headers.get("Last-Modified")).toBe(first.headers.get("Last-Modified"));
    expect(second.headers.get("Cache-Control")).toBe(first.headers.get("Cache-Control"));
    expect(await second.text()).toBe(await first.text());
  });

  test("revalidation still answers 304 from the cached validator", async () => {
    const server = await app(false);

    const first = await get(server, "/styles.css");
    const etag = first.headers.get("ETag")!;
    expect(etag).toBeTruthy();

    // Second request is the one served from the cache; If-None-Match has to be
    // compared against the remembered tag, not a freshly read one.
    const revalidated = await get(server, "/styles.css", { "If-None-Match": etag });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe("");
  });

  test("the security headers are still applied on a cached hit", async () => {
    const server = await app(false);
    await get(server, "/styles.css");
    const second = await get(server, "/styles.css");

    expect(second.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(second.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  test("a path that is not a file is still a miss after a real hit", async () => {
    const server = await app(false);
    await get(server, "/styles.css");

    // Falls through to the router, which has no such route.
    const missing = await get(server, "/not-a-file.css");
    expect(missing.status).toBe(404);
  });

  test("traversal is refused whether or not something was cached first", async () => {
    const server = await app(false);
    await get(server, "/styles.css");

    for (const path of ["/../routes/index.tsx", "/..%2Froutes%2Findex.tsx", "/.env"]) {
      const response = await get(server, path);
      expect(response.status).not.toBe(200);
    }
  });
});

describe("dev", () => {
  test("an edited file is picked up rather than served from a remembered validator", async () => {
    const server = await app(true);
    const dir = join(ROOT, "public");

    const before = await get(server, "/styles.css");
    expect(await before.text()).toBe("body{color:red}");

    writeFileSync(join(dir, "styles.css"), "body{color:blue}");

    const after = await get(server, "/styles.css");
    expect(await after.text()).toBe("body{color:blue}");

    // Restore, so the production tests above do not depend on execution order.
    writeFileSync(join(dir, "styles.css"), "body{color:red}");
  });
});
