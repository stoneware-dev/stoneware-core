/**
 * Router unit tests - file conventions in, matched route out (CLAUDE.md §7).
 *
 * Runs against test/fixture rather than the docs site, so route assertions do
 * not depend on documentation content.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Router } from "../src/router.ts";

const FIXTURE_ROUTES = join(import.meta.dir, "fixture", "routes");

async function router(): Promise<Router> {
  const instance = new Router(FIXTURE_ROUTES);
  await instance.init();
  return instance;
}

describe("route table", () => {
  test("maps files to Next.js-style patterns", async () => {
    const patterns = Object.keys((await router()).routes).sort();
    expect(patterns).toEqual(["/", "/api/echo", "/blog/[slug]", "/plain"]);
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
    const match = await (await router()).match("/blog/hello-world");
    expect(match?.kind).toBe("page");
    expect(match?.params).toEqual({ slug: "hello-world" });
  });

  test("returns null for unknown paths", async () => {
    expect(await (await router()).match("/nope")).toBeNull();
  });
});

describe("percent-encoded paths", () => {
  // Regression guard for a Bun 1.3.14 native panic: passing any path containing
  // "%" to FileSystemRouter.match() aborts the process. Request paths are
  // attacker-controlled, so an unguarded router is a remote DoS. See report.md.
  // If these ever crash the runner rather than fail, the mitigation regressed.

  test("a bare percent does not crash the process", async () => {
    expect(await (await router()).match("/blog/%")).toBeNull();
  });

  test("a valid escape on a static route does not crash the process", async () => {
    expect(await (await router()).match("/%41")).toBeNull();
  });

  test("decodes escapes into params", async () => {
    const match = await (await router()).match("/blog/%41");
    expect(match?.params).toEqual({ slug: "A" });
  });

  test("decodes multi-byte UTF-8 escapes", async () => {
    const match = await (await router()).match("/blog/caf%C3%A9");
    expect(match?.params).toEqual({ slug: "café" });
  });

  test("a literal percent survives the round trip", async () => {
    const match = await (await router()).match("/blog/100%25");
    expect(match?.params).toEqual({ slug: "100%" });
  });

  test("encoded slashes stay inside one segment", async () => {
    // Decoding before matching would let this satisfy a two-segment route.
    const match = await (await router()).match("/blog/a%2Fb");
    expect(match?.name).toBe("/blog/[slug]");
    expect(match?.params).toEqual({ slug: "a/b" });
  });

  test("malformed escapes match nothing", async () => {
    expect(await (await router()).match("/blog/%zz")).toBeNull();
  });

  test("does not decode into a NUL byte", async () => {
    expect(await (await router()).match("/blog/%00")).toBeNull();
  });
});

describe("classification", () => {
  test("a module exporting HTTP handlers is a server action", async () => {
    const match = await (await router()).match("/api/echo");
    expect(match?.kind).toBe("action");
    expect(Object.keys((match as { handlers: object }).handlers)).toEqual(["POST"]);
  });

  test("a module default-exporting a component is a page", async () => {
    const match = await (await router()).match("/plain");
    expect(match?.kind).toBe("page");
    expect(typeof (match as { component: unknown }).component).toBe("function");
  });
});
