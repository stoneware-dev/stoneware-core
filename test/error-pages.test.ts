/**
 * Custom error pages: `routes/_404.tsx` and `routes/_500.tsx`.
 *
 * Two apps are built here - one dev, one production - because the dev-only
 * `error` prop and the production message-hiding are the same code path seen
 * from both sides.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/server.ts";
import type { StonewareApp } from "../src/server.ts";

/**
 * A project that defines both error pages, plus a route that always throws.
 * Kept apart from test/fixture so the other suites still describe a project
 * with no error pages - which is the fallback case tested at the bottom.
 */
const FIXTURE_ROOT = join(import.meta.dir, "fixture-errors");
const SECRET = "error-page-test-secret-0123456789";

let dev: StonewareApp;

beforeAll(async () => {
  dev = await createApp({ root: FIXTURE_ROOT, csrf: { secret: SECRET } }, { dev: true });
});

const get = (app: StonewareApp, path: string) => app.fetch(new Request(`http://localhost${path}`));

describe("custom 404", () => {
  test("renders routes/_404.tsx with a 404 status", async () => {
    const response = await get(dev, "/no-such-page");
    expect(response.status).toBe(404);

    const html = await response.text();
    expect(html).toContain("Custom 404");
    expect(html).toContain("/no-such-page");
  });

  test("is never cached", async () => {
    // A CDN holding a 404 outlives the deploy that adds the missing page.
    const response = await get(dev, "/no-such-page");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  test("still carries the security headers", async () => {
    const response = await get(dev, "/no-such-page");
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("custom 500", () => {
  test("renders routes/_500.tsx when a route throws", async () => {
    const response = await get(dev, "/boom");
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Custom 500");
  });

  test("exposes the thrown error in dev", async () => {
    expect(await (await get(dev, "/boom")).text()).toContain("fixture route failed on purpose");
  });

  test("withholds the thrown error in production", async () => {
    // The message routinely carries a path, a query, or a connection string.
    const prod = await createApp({ root: FIXTURE_ROOT, csrf: { secret: SECRET } }, { dev: false });
    const html = await (await get(prod, "/boom")).text();

    expect(html).toContain("Custom 500");
    expect(html).not.toContain("fixture route failed on purpose");
  });
});

describe("reserved routes", () => {
  test("an error page is not reachable as a page", async () => {
    // Without this, /_404 would answer with a 200 and the error page would be
    // servable as ordinary content.
    const response = await get(dev, "/_404");
    expect(response.status).toBe(404);
  });

  test("the 404 it renders is the error page itself", async () => {
    expect(await (await get(dev, "/_404")).text()).toContain("Custom 404");
  });
});

describe("fallback when no error page exists", () => {
  test("a project without _404.tsx still gets a safe 404", async () => {
    // test/fixture defines no error pages, so this is the built-in page.
    const bare = await createApp(
      { root: join(import.meta.dir, "fixture"), csrf: { secret: SECRET } },
      { dev: true },
    );
    const response = await get(bare, "/missing");

    expect(response.status).toBe(404);
    expect(await response.text()).toContain("404");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
