/**
 * Router unit tests - file conventions in, matched route out (CLAUDE.md §7).
 *
 * Runs against test/fixture rather than the docs site, so route assertions do
 * not depend on documentation content.
 */

import { describe, expect, test } from "bun:test";
import { compileRoutes, matchRoute } from "../src/route-table.ts";
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

describe("route precedence and the literal index", () => {
  // Literal patterns are held in a map and tried before the dynamic scan, which
  // is what keeps matching flat as a project grows. That is only sound because
  // a literal already outranks a dynamic route wherever both could match - so
  // these assert the precedence rather than the data structure.
  const index = () =>
    compileRoutes({
      "/": "index.tsx",
      "/blog": "blog.tsx",
      "/blog/new": "new.tsx",
      "/blog/[slug]": "slug.tsx",
      "/shop/[category]/[item]": "item.tsx",
      "/shop/sale/[item]": "sale.tsx",
      "/files/[...path]": "files.tsx",
      "/[...catchall]": "catchall.tsx",
    });

  const match = (path: string) => matchRoute(index(), path);

  test("a literal beats a dynamic route that also matches", () => {
    expect(match("/blog/new")?.pattern).toBe("/blog/new");
    expect(match("/blog/other")?.pattern).toBe("/blog/[slug]");
  });

  test("a literal beats a catch-all that also matches", () => {
    expect(match("/blog")?.pattern).toBe("/blog");
    expect(match("/")?.pattern).toBe("/");
    expect(match("/unknown")?.pattern).toBe("/[...catchall]");
  });

  test("a literal segment beats a param at the same position", () => {
    expect(match("/shop/sale/hammer")?.pattern).toBe("/shop/sale/[item]");
    expect(match("/shop/tools/hammer")?.pattern).toBe("/shop/[category]/[item]");
  });

  test("a literal match carries no params, and its own object", () => {
    const first = match("/blog/new");
    const second = match("/blog/new");
    expect(first?.params).toEqual({});
    // Not a shared singleton: a caller that writes to params must not be able
    // to affect the next request.
    expect(first?.params).not.toBe(second?.params);
  });

  test("params are still extracted when nothing captures until late", () => {
    expect(match("/shop/tools/hammer")?.params).toEqual({ category: "tools", item: "hammer" });
    expect(match("/files/a/b/c.png")?.params).toEqual({ path: "a/b/c.png" });
  });

  test("segment count still decides a non-catch-all route", () => {
    // The length pre-check rejects most candidates before the walk; it must not
    // reject one that genuinely matches, nor accept a shorter or longer path.
    expect(match("/shop/tools")?.pattern).toBe("/[...catchall]");
    expect(match("/shop/tools/hammer/extra")?.pattern).toBe("/[...catchall]");
  });

  test("every route is still listed in match order", () => {
    // `stoneware routes` reads this, and it is only useful if it is the order
    // requests are actually tried in.
    const patterns = index().all.map((route) => route.pattern);
    expect(patterns.indexOf("/blog/new")).toBeLessThan(patterns.indexOf("/blog/[slug]"));
    expect(patterns.indexOf("/shop/sale/[item]")).toBeLessThan(
      patterns.indexOf("/shop/[category]/[item]"),
    );
    expect(patterns.indexOf("/blog")).toBeLessThan(patterns.indexOf("/[...catchall]"));
    // "/" is last, and harmlessly so: zero segments loses the longer-first
    // tiebreak, and it is the only pattern that can match the empty path.
    expect(patterns.at(-1)).toBe("/");
    expect(patterns).toHaveLength(8);
  });
});
