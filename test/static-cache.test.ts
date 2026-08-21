/**
 * What is remembered about a served file, and what deliberately is not.
 *
 * Serving an asset cost four filesystem round trips — the existence check in
 * safeJoin, the link check, `file.exists()`, then size and mtime for the
 * validator. Measured over HTTP that made serving a stylesheet slower than
 * rendering a whole page.
 *
 * The first version of this cache remembered the validator too, which was
 * wrong. Resolving a path costs ~0.10ms (`realpathSync` alone is ~0.087ms);
 * reading size and mtime costs ~0.008ms. Keeping the second saved almost
 * nothing and pinned clients to bytes that had since changed. So the path is
 * cached and the validator is read per request, and these tests pin both
 * halves: the saving, and the freshness.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createApp } from "../src/http/server.ts";

const ROOT = join(tmpdir(), `stoneware-static-cache-${Date.now()}`);
const PUBLIC = join(ROOT, "public");
const ROUTES = join(ROOT, "routes");

const SECRET = "static-cache-test-secret-not-a-real-one";

beforeAll(() => {
  mkdirSync(PUBLIC, { recursive: true });
  mkdirSync(ROUTES, { recursive: true });
  writeFileSync(join(PUBLIC, "styles.css"), "body{color:red}");
  // Present before any app starts: the startup listing only contains files that
  // were there when it was read, and these tests are about contents changing,
  // not about files appearing.
  writeFileSync(join(PUBLIC, "mutable.css"), "body{color:red}");
  writeFileSync(join(PUBLIC, "doomed.css"), "body{}");
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

describe("a file that changes under a running server", () => {
  /**
   * The regression this cache caused and now must not.
   *
   * Replacing a file in public/ served the new bytes with the old ETag, so a
   * client holding that tag revalidated to 304 for the life of the process —
   * correct content, stale validator, and permanent from the client's side.
   */
  const mutable = () => join(PUBLIC, "mutable.css");

  test("the ETag follows the contents", async () => {
    writeFileSync(mutable(), "body{color:red}");
    const server = await app(false);

    const before = await get(server, "/mutable.css");
    const oldEtag = before.headers.get("ETag");
    expect(await before.text()).toBe("body{color:red}");
    expect(oldEtag).toBeTruthy();

    // Long enough that mtime differs: the validator has second resolution.
    await Bun.sleep(1100);
    writeFileSync(mutable(), "body{color:blue}");

    const after = await get(server, "/mutable.css");
    expect(await after.text()).toBe("body{color:blue}");
    expect(after.headers.get("ETag")).not.toBe(oldEtag);
  });

  test("the old validator no longer revalidates to 304", async () => {
    writeFileSync(mutable(), "body{color:red}");
    const server = await app(false);

    const before = await get(server, "/mutable.css");
    const oldEtag = before.headers.get("ETag")!;
    await before.arrayBuffer();

    await Bun.sleep(1100);
    writeFileSync(mutable(), "body{color:blue}");

    // The whole bug in one assertion: a client that kept the old tag must be
    // given the new file, not told it is still current.
    const revalidated = await get(server, "/mutable.css", { "If-None-Match": oldEtag });
    expect(revalidated.status).toBe(200);
    expect(await revalidated.text()).toBe("body{color:blue}");
  });

  test("Last-Modified follows the contents too", async () => {
    writeFileSync(mutable(), "a");
    const server = await app(false);

    const before = await get(server, "/mutable.css");
    const oldModified = before.headers.get("Last-Modified");
    await before.arrayBuffer();

    await Bun.sleep(1100);
    writeFileSync(mutable(), "b");

    const after = await get(server, "/mutable.css");
    await after.arrayBuffer();
    expect(after.headers.get("Last-Modified")).not.toBe(oldModified);
  });

  test("an unchanged file still answers 304", async () => {
    // The saving has to survive the fix: nothing changed, so nothing is resent.
    writeFileSync(mutable(), "body{color:green}");
    const server = await app(false);

    const first = await get(server, "/mutable.css");
    const etag = first.headers.get("ETag")!;
    await first.arrayBuffer();

    for (let i = 0; i < 3; i++) {
      const again = await get(server, "/mutable.css", { "If-None-Match": etag });
      expect(again.status).toBe(304);
      expect(await again.text()).toBe("");
    }
  });

  test("a file deleted after startup answers 404 rather than an empty 200", async () => {
    // The path is indexed and cached; the file is not there any more. Serving a
    // zero-byte 200 would look like a broken asset rather than a missing one.
    const doomed = join(PUBLIC, "doomed.css");
    writeFileSync(doomed, "body{}");
    const server = await app(false);

    expect((await get(server, "/doomed.css")).status).toBe(200);

    rmSync(doomed, { force: true });

    const gone = await get(server, "/doomed.css");
    expect(gone.status).toBe(404);
  });
});
