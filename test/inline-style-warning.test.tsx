/**
 * The renderer and the default CSP disagreed about `style=`, silently.
 *
 * `style-src 'self'` governs style *attributes*, not only `<style>` blocks, so
 * the default policy blocks them. The renderer emitted them anyway: the element
 * appears, the declaration is in the HTML, and the browser refuses to apply it.
 * Nothing errors and nothing is logged, which is the failure shape this project
 * keeps producing and the one worth being loud about.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToString } from "../src/render/render.ts";
import { DEFAULT_CSP, resolveConfig } from "../src/config.ts";
import { withRenderContext } from "../src/http/context.ts";
import type { RenderContext } from "../src/http/context.ts";

function contextWith(csp: string | false, dev: boolean): RenderContext {
  process.env.STONEWARE_CSRF_SECRET = "inline-style-test-secret-0123456789";
  return {
    config: resolveConfig({ csp, root: process.cwd() }, dev),
    personalized: false,
    preloads: new Set<string>(),
    renderingHead: false,
    seoOutsideHead: false,
  } as RenderContext;
}

let warnings: string[] = [];
const realWarn = console.warn;

beforeEach(() => {
  warnings = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
});

afterEach(() => {
  console.warn = realWarn;
});

/** Each tag warns once per process, so every case needs its own element. */
async function render(tag: string, csp: string | false, dev: boolean): Promise<string> {
  return await withRenderContext(contextWith(csp, dev), async () => {
    const el = { type: tag, props: { style: { color: "red" } } };
    return renderToString(
      // Built by hand rather than via JSX so the tag can vary per test.
      { ...el, [Symbol.for("stoneware.vnode")]: true, key: null } as never,
    ).html;
  });
}

describe("under a policy that blocks inline styles", () => {
  test("warns in development", async () => {
    await render("section", DEFAULT_CSP, true);
    expect(warnings.join("\n")).toMatch(/will be ignored by the browser/);
  });

  test("names the fix", async () => {
    await render("article", DEFAULT_CSP, true);
    expect(warnings.join("\n")).toMatch(/Use a class and a \.css file/);
  });

  test("still renders the attribute", async () => {
    // A warning, not a rewrite: the project may be about to widen its policy,
    // and a heuristic must not change output.
    const html = await render("aside", DEFAULT_CSP, true);
    expect(html).toContain('style="color:red;"');
  });

  test("says nothing in production", async () => {
    // A per-render console write on every page of a busy site, to tell an
    // operator something only the author can act on.
    await render("footer", DEFAULT_CSP, false);
    expect(warnings).toEqual([]);
  });
});

describe("under a policy that permits them", () => {
  test("silent when the project allows unsafe-inline", async () => {
    await render("header", "default-src 'self'; style-src 'self' 'unsafe-inline'", true);
    expect(warnings).toEqual([]);
  });

  test("silent when the header is turned off entirely", async () => {
    // `csp: false` is an explicit, greppable choice. Nothing is being blocked.
    await render("main", false, true);
    expect(warnings).toEqual([]);
  });

  test("silent when the policy sets no style-src", async () => {
    await render("nav", "default-src 'self'", true);
    expect(warnings).toEqual([]);
  });
});
