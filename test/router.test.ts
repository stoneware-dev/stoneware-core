/**
 * Router unit tests - file conventions in, matched route out (CLAUDE.md §7).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Router } from "../src/router.ts";

const EXAMPLE_ROUTES = join(import.meta.dir, "..", "example", "routes");

async function router(): Promise<Router> {
  const instance = new Router(EXAMPLE_ROUTES);
  await instance.init();
  return instance;
}

describe("route table", () => {
  test("maps files to Next.js-style patterns", async () => {
    const patterns = Object.keys((await router()).routes).sort();
    expect(patterns).toEqual(["/", "/about", "/api/subscribe", "/blog/[slug]"]);
  });

  test("missing routes directory fails loudly at init", async () => {
    const instance = new Router(join(import.meta.dir, "does-not-exist"));
    expect(instance.init()).rejects.toThrow(/Routes directory not found/);
  });
});

describe("matching", () => {
  test("resolves index to /", async () => {
    const match = await (await router()).match("/");
    expect(match?.kind).toBe("page");
    expect(match?.name).toBe("/");
  });

  test("extracts dynamic segment params", async () => {
    const match = await (await router()).match("/blog/islands");
    expect(match?.kind).toBe("page");
    expect(match?.params).toEqual({ slug: "islands" });
  });

  test("returns null for unknown paths", async () => {
    expect(await (await router()).match("/nope")).toBeNull();
  });
});

describe("classification", () => {
  test("a module exporting HTTP handlers is a server action", async () => {
    const match = await (await router()).match("/api/subscribe");
    expect(match?.kind).toBe("action");
    expect(Object.keys((match as { handlers: object }).handlers)).toEqual(["POST"]);
  });

  test("a module default-exporting a component is a page", async () => {
    const match = await (await router()).match("/about");
    expect(match?.kind).toBe("page");
    expect(typeof (match as { component: unknown }).component).toBe("function");
  });
});
