/**
 * What a shared cache is told about an HTML response.
 *
 * `personalized` means "this render issued a CSRF token". It has never meant
 * "this page is the same for everyone", and a route that reads a session cookie
 * personalizes its output without going near CSRF. Such a page was published as
 * `public` with nothing saying what it depended on.
 *
 * Measured against a cache that keys on the URL and serves what it holds — the
 * "cache everything" configuration every CDN offers: Alice arrived first, and
 * Bob, Carol and an anonymous visitor were all served Alice's page. Three of
 * three. `Vary` is what stops the key being the URL alone.
 *
 * These tests exist to keep that header attached to the responses that need it
 * and off the ones that would only lose cache reuse by carrying it.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createApp } from "../src/server.ts";

// A fixture inside the repo rather than in a temp directory: routes here are
// JSX, and `stoneware/jsx-runtime` only resolves from within the package.
const ROOT = join(import.meta.dir, "fixture-cache");

const SECRET = "shared-cache-safety-test-secret";

const app = (extra: Record<string, unknown> = {}, dev = false) =>
  createApp(
    { root: ROOT, csrf: { secret: SECRET }, ...extra },
    { dev, islandManifest: {}, stylesheet: null },
  );

const get = (
  a: Awaited<ReturnType<typeof createApp>>,
  path: string,
  headers?: HeadersInit,
) => a.fetch(new Request(`http://localhost${path}`, { headers }));

describe("cacheable HTML", () => {
  test("declares what a shared cache must key on", async () => {
    const server = await app();
    const response = await get(server, "/account", { cookie: "session=alice" });
    await response.arrayBuffer();

    expect(response.headers.get("Cache-Control")).toBe("public, no-cache");
    expect(response.headers.get("Vary")).toBe("Cookie, Authorization");
  });

  test("declares it on a page that reads nothing, too", async () => {
    // Vary describes the resource, not the request. A response cached from a
    // request that carried no cookie would otherwise be reused for one that
    // does — which is the whole failure, arriving one step later.
    const server = await app();
    const response = await get(server, "/");
    await response.arrayBuffer();

    expect(response.headers.get("Vary")).toBe("Cookie, Authorization");
  });

  test("keeps it on a 304, where the cache is actually listening", async () => {
    // A revalidating cache reads the headers of the 304 to update what it
    // stored. Dropping Vary there would undo the fix on the second request.
    const server = await app();
    const first = await get(server, "/");
    const etag = first.headers.get("ETag")!;
    await first.arrayBuffer();

    const revalidated = await get(server, "/", { "If-None-Match": etag });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("Vary")).toBe("Cookie, Authorization");
  });

  test("two visitors get different bodies and different validators", async () => {
    const server = await app();
    const alice = await get(server, "/account", { cookie: "session=alice" });
    const bob = await get(server, "/account", { cookie: "session=bob" });

    expect(await alice.clone().text()).toContain("alice");
    expect(await bob.clone().text()).toContain("bob");
    expect(alice.headers.get("ETag")).not.toBe(bob.headers.get("ETag"));
  });
});

describe("responses a shared cache must not store at all", () => {
  test("a page that rendered a CSRF token is private and unstored", async () => {
    const server = await app();
    const response = await get(server, "/contact");
    await response.arrayBuffer();

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    // No ETag either: a fresh token per render means the body changes each time.
    expect(response.headers.get("ETag")).toBeNull();
  });

  test("development responses are never stored", async () => {
    const server = await app({}, true);
    const response = await get(server, "/");
    await response.arrayBuffer();

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a 404 is not stored", async () => {
    const server = await app();
    const response = await get(server, "/no-such-page");
    await response.arrayBuffer();

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("static assets", () => {
  test("do not carry Vary", async () => {
    // Bytes from disk, identical for every visitor. Fragmenting a CDN's key for
    // them would cost reuse and buy no correctness.
    const server = await app();
    const response = await get(server, "/styles.css", { cookie: "session=alice" });
    await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(response.headers.get("Vary")).toBeNull();
  });

  test("still revalidate normally with a cookie present", async () => {
    const server = await app();
    const first = await get(server, "/styles.css");
    const etag = first.headers.get("ETag")!;
    await first.arrayBuffer();

    const again = await get(server, "/styles.css", {
      "If-None-Match": etag,
      cookie: "session=alice",
    });
    expect(again.status).toBe(304);
  });
});

describe("composition with CORS", () => {
  test("Vary: Origin is added alongside rather than replacing", async () => {
    // withCORS appends. If it ever overwrote, the cookie key would vanish on
    // exactly the deployments that also serve an API.
    const server = await app({ cors: { origin: ["https://example.com"] } });
    const response = await get(server, "/", { origin: "https://example.com" });
    await response.arrayBuffer();

    const vary = response.headers.get("Vary") ?? "";
    expect(vary).toContain("Cookie");
    expect(vary).toContain("Authorization");
    expect(vary).toContain("Origin");
  });
});
