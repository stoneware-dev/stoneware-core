/**
 * The server and client renderers must agree about what an attribute may be.
 *
 * They used to decide independently, and drifted: the handler pattern was
 * tightened in the renderer and left alone in the client, so an island was
 * checked on first paint and unchecked on every update afterwards. These tests
 * assert the two agree, so a future divergence fails here rather than shipping.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToString } from "../src/render.ts";
import { signal } from "@preact/signals-core";

GlobalRegistrator.register();
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { mountTree } = await import("../src/client/dom.ts");

/** Mount on the client and hand back the resulting element. */
function mount(tree: Parameters<typeof mountTree>[0]): Element {
  const { fragment } = mountTree(tree);
  return fragment.firstElementChild!;
}

const errors: string[] = [];
beforeEach(() => {
  errors.length = 0;
  console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
});

describe("event handlers", () => {
  test("a lowercase handler is dropped on both sides", () => {
    const untrusted = { onclick: "alert(1)" } as Record<string, unknown>;

    // Server
    expect(renderToString(<div {...untrusted} />).html).toBe("<div></div>");

    // Client — the half that was still using /^on[A-Z]/
    expect(mount(<div {...untrusted} />).hasAttribute("onclick")).toBe(false);
  });

  test("a real function handler still binds on the client", () => {
    let clicked = false;
    const el = mount(<button onClick={() => (clicked = true)} />) as HTMLElement;

    el.click();
    expect(clicked).toBe(true);
  });
});

describe("URL schemes", () => {
  test("the server refuses javascript: outright", () => {
    expect(() => renderToString(<a href="javascript:alert(1)">x</a>)).toThrow(/executes/);
  });

  test("the client refuses it too, without destroying the island", () => {
    // A throw here would take out a live island over one bad value, so the
    // attribute is declined instead.
    const el = mount(<a href="javascript:alert(1)">x</a>);

    expect(el.hasAttribute("href")).toBe(false);
    expect(errors.join("\n")).toContain("Refused to set href");
  });

  test("and refuses it when a signal supplies it after hydration", () => {
    // The case that was unguarded: same code, safe on first paint, unsafe on
    // every update.
    const href = signal("/safe");
    const el = mount(<a href={href}>x</a>);
    expect(el.getAttribute("href")).toBe("/safe");

    href.value = "javascript:alert(1)";
    expect(el.hasAttribute("href")).toBe(false);
    expect(errors.join("\n")).toContain("Refused to set href");
  });

  test("obfuscated schemes are caught on the client as well", () => {
    for (const value of ["JaVaScRiPt:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)"]) {
      expect(mount(<a href={value}>x</a>).hasAttribute("href")).toBe(false);
    }
  });

  test("ordinary URLs are set on both sides", () => {
    expect(renderToString(<a href="/about">x</a>).html).toContain('href="/about"');
    expect(mount(<a href="/about">x</a>).getAttribute("href")).toBe("/about");
  });

  test("a data: image is allowed in src on both sides", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";

    expect(renderToString(<img src={src} alt="" />).html).toContain("data:image/png");
    expect(mount(<img src={src} alt="" />).getAttribute("src")).toBe(src);
  });
});
