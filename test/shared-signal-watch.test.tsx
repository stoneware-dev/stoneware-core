/**
 * The development check for signals that carry state between requests.
 *
 * The bug it exists for was reproduced before it was written: a two-route
 * fixture where a route assigned to a module-scope signal served the previous
 * visitor's identity and basket to a request that supplied no parameters, and
 * served one concurrent request's data to another. Nothing about that failure
 * is loud — the page renders, the types check, the status is 200 — which is why
 * a check is worth having at all.
 *
 * What is asserted here is as much about staying quiet as about warning. A
 * diagnostic that cries wolf on the normal island-sharing pattern would be
 * worse than none, because it would train people to ignore it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { signal, computed } from "@preact/signals-core";

import { renderToString, resetSharedSignalWatch } from "../src/render/render.ts";
import { withRenderContext } from "../src/http/context.ts";
import { resolveConfig } from "../src/config.ts";
import type { RenderContext } from "../src/http/context.ts";

const SECRET = "shared-signal-watch-test";

/** A render context standing in for one request. */
function contextFor(dev: boolean): RenderContext {
  return {
    config: resolveConfig({ csrf: { secret: SECRET } }, dev),
    request: new Request("http://localhost/"),
    url: new URL("http://localhost/"),
    personalized: false,
    preloads: new Set<string>(),
    renderingHead: false,
    seoOutsideHead: false,
    caught: [],
  };
}

/** Render as though inside one request, capturing anything warned. */
function renderAsRequest(tree: unknown, { dev = true } = {}): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    withRenderContext(contextFor(dev), () => renderToString(tree as never));
  } finally {
    console.warn = original;
  }
  return warnings;
}

beforeEach(() => resetSharedSignalWatch());
afterEach(() => resetSharedSignalWatch());

describe("a signal written during SSR", () => {
  test("is reported once the value changes between requests", () => {
    // The shape of the real bug: a route assigns per-visitor data to a signal
    // that outlives the request.
    const cart = signal(0);

    cart.value = 7; // request A
    expect(renderAsRequest(<span>{cart}</span>)).toHaveLength(0);

    cart.value = 99; // request B, a different visitor
    const warnings = renderAsRequest(<span>{cart}</span>);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("changed value between renders");
    expect(warnings[0]).toContain("7 -> 99");
  });

  test("names the element it was rendered inside", () => {
    const viewer = signal("alice");
    renderAsRequest(<em>{viewer}</em>);
    viewer.value = "bob";

    expect(renderAsRequest(<em>{viewer}</em>)[0]).toContain("<em>");
  });

  test("points at props as the fix", () => {
    const count = signal(1);
    renderAsRequest(<span>{count}</span>);
    count.value = 2;

    const message = renderAsRequest(<span>{count}</span>)[0];
    expect(message).toContain("prop");
    expect(message).toContain("per server process");
  });

  test("reports once per signal, not once per request", () => {
    // A page under a dev reload loop would otherwise print this forever.
    const count = signal(0);
    renderAsRequest(<span>{count}</span>);

    let total = 0;
    for (let i = 1; i <= 5; i++) {
      count.value = i;
      total += renderAsRequest(<span>{count}</span>).length;
    }

    expect(total).toBe(1);
  });

  test("reports each offending signal separately", () => {
    const a = signal("a1");
    const b = signal("b1");
    renderAsRequest(
      <div>
        {a}
        {b}
      </div>,
    );

    a.value = "a2";
    b.value = "b2";
    expect(renderAsRequest(
      <div>
        {a}
        {b}
      </div>,
    )).toHaveLength(2);
  });
});

describe("what it must not report", () => {
  test("a shared signal that is only ever read", () => {
    // This is the documented way to share state between islands. It is safe,
    // and a warning here would teach people to ignore the check.
    const subscribers = signal(1284);

    let warnings = 0;
    for (let i = 0; i < 5; i++) warnings += renderAsRequest(<span>{subscribers}</span>).length;

    expect(warnings).toBe(0);
  });

  test("a signal created fresh inside a component", () => {
    // Per-render state is the correct pattern and produces a different object
    // every time, so there is no history to compare against.
    function Widget() {
      const local = signal(Math.random());
      return <span>{local}</span>;
    }

    let warnings = 0;
    for (let i = 0; i < 5; i++) warnings += renderAsRequest(<Widget />).length;

    expect(warnings).toBe(0);
  });

  test("anything at all in production", () => {
    const leaky = signal(0);

    renderAsRequest(<span>{leaky}</span>, { dev: false });
    leaky.value = 42;

    expect(renderAsRequest(<span>{leaky}</span>, { dev: false })).toHaveLength(0);
  });

  test("a render with no request context", () => {
    // renderToString called by hand — a test, a fragment, a helper. There is no
    // request to leak between, and no config saying whether this is dev.
    const loose = signal(0);
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));

    try {
      renderToString(<span>{loose}</span>);
      loose.value = 5;
      renderToString(<span>{loose}</span>);
    } finally {
      console.warn = original;
    }

    expect(warnings).toHaveLength(0);
  });

  test("a signal reaching the same value it already had", () => {
    const status = signal("ready");
    renderAsRequest(<span>{status}</span>);

    status.value = "busy";
    status.value = "ready"; // back where it started before rendering

    expect(renderAsRequest(<span>{status}</span>)).toHaveLength(0);
  });
});

describe("derived values", () => {
  test("a computed over a leaking signal is reported too", () => {
    // Both point at the same mistake. Reporting the computed as well is noise
    // worth accepting: it is the value actually on the page, and suppressing it
    // would need a way to tell a computed from a signal that the library does
    // not offer.
    const items = signal(1);
    const label = computed(() => `${items.value} items`);

    renderAsRequest(<span>{label}</span>);
    items.value = 2;

    const warnings = renderAsRequest(<span>{label}</span>);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("items");
  });
});

describe("the message", () => {
  test("summarises long strings rather than printing them whole", () => {
    const text = signal("short");
    renderAsRequest(<span>{text}</span>);
    text.value = "x".repeat(200);

    const message = renderAsRequest(<span>{text}</span>)[0];
    expect(message).toContain("…");
    expect(message.length).toBeLessThan(700);
  });

  test("describes an array by length rather than serialising it", () => {
    // A signal holding a plain object cannot reach this code at all — the
    // renderer refuses to render one, with its own clearer message. An array
    // is renderable, so it is the collection case that actually occurs.
    const rows = signal<string[]>(["a"]);
    renderAsRequest(<span>{rows as never}</span>);
    rows.value = ["a", "b", "c"];

    const message = renderAsRequest(<span>{rows as never}</span>)[0];
    expect(message).toContain("[…1] -> […3]");
  });
});
