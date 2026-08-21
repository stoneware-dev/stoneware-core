/**
 * Bug 2: a page that matched but has no content.
 *
 * `routes/_404.tsx` only fires when nothing matched. A `[slug]` route matches
 * any slug, so without `notFound()` a template could only render "no such page"
 * markup and serve it with a 200 - a soft 404 that search engines index.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/http/server.ts";
import { isNotFound, notFound } from "../src/helpers/not-found.ts";
import type { StonewareApp } from "../src/http/server.ts";

const FIXTURE_ROOT = join(import.meta.dir, "fixture-errors");

let app: StonewareApp;

beforeAll(async () => {
  app = await createApp(
    { root: FIXTURE_ROOT, csrf: { secret: "not-found-test-secret-01234567" } },
    { dev: true },
  );
});

const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));

describe("notFound() from a page", () => {
  test("a slug that exists renders normally", async () => {
    const response = await get("/post/hello");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hello world");
  });

  test("a slug that does not exist answers 404, not 200", async () => {
    // The whole point. This route matched, so _404 would never have fired.
    const response = await get("/post/missing");
    expect(response.status).toBe(404);
  });

  test("it renders the project's own _404 page", async () => {
    expect(await (await get("/post/missing")).text()).toContain("Custom 404");
  });

  test("the response is not cached", async () => {
    expect((await get("/post/missing")).headers.get("Cache-Control")).toBe("no-store");
  });

  test("security headers still apply", async () => {
    const response = await get("/post/missing");
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});

describe("the signal itself", () => {
  test("it is recognisable, and not an ordinary error", () => {
    // An error page or logger inspecting a thrown value should not have to tell
    // a deliberate 404 from a real crash by reading a message.
    try {
      notFound();
      throw new Error("notFound() did not throw");
    } catch (error) {
      expect(isNotFound(error)).toBe(true);
      expect(error instanceof Error).toBe(false);
    }
  });

  test("a real error is not mistaken for one", () => {
    expect(isNotFound(new Error("boom"))).toBe(false);
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound("Not Found")).toBe(false);
  });

  test("a thrown route still produces a 500, not a 404", async () => {
    // The distinction has to survive the shared catch.
    expect((await get("/boom")).status).toBe(500);
  });
});
