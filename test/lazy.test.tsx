/**
 * Lazy island hydration: the `client:*` directives.
 *
 * Server-side assertions come first and need no DOM. The client half registers
 * happy-dom, so it lives in its own file-level block at the bottom with the
 * usual unregister in `afterAll`.
 */

import { describe, expect, test } from "bun:test";
import { buildDocument } from "../src/render/document.ts";
import { RUNTIME_CHUNK_KEY } from "../src/build/build.ts";
import { renderToString } from "../src/render/render.ts";
import type { Component } from "../src/render/types.ts";

function Counter(props: { start?: number }) {
  return <button type="button">Clicked {props.start ?? 0} times</button>;
}

function Badge() {
  return <span>badge</span>;
}

const ISLANDS = new Map<Component<any>, string>([
  [Counter, "Counter"],
  [Badge, "Badge"],
]);

const MANIFEST = {
  Counter: "/_stoneware/Counter-aaaa.js",
  Badge: "/_stoneware/Badge-bbbb.js",
  [RUNTIME_CHUNK_KEY]: "/_stoneware/stoneware-runtime-cccc.js",
};

function document_(tree: Parameters<typeof renderToString>[0]): string {
  const rendered = renderToString(tree, { islands: ISLANDS });
  return buildDocument({ html: rendered.html, islands: rendered.islands, manifest: MANIFEST });
}

function payloadOf(html: string): {
  islands: { name: string; id: string; props: Record<string, unknown>; on?: string; q?: string }[];
  chunks: Record<string, string>;
} {
  const match = html.match(
    /<script type="application\/json" id="stoneware-islands">(.*?)<\/script>/s,
  );
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

const scriptsIn = (html: string) =>
  [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map((m) => m[1]!);

describe("directives on the server", () => {
  test("an eager island is unchanged: a script tag and no strategy in the payload", () => {
    const html = document_(<Counter />);

    expect(scriptsIn(html)).toEqual(["/_stoneware/Counter-aaaa.js"]);
    const payload = payloadOf(html);
    expect(payload.islands[0]!.on).toBeUndefined();
    expect(payload.chunks).toEqual({});
  });

  test("a lazy island ships no script tag for itself", () => {
    // This is the entire point: the chunk must not be fetched up front.
    const html = document_(<Counter client:visible />);

    // Only the runtime. The island's URL is still in the document - inside the
    // JSON payload, where it is data for the scheduler rather than a fetch.
    expect(scriptsIn(html)).toEqual(["/_stoneware/stoneware-runtime-cccc.js"]);
    expect(html).not.toContain('<script type="module" src="/_stoneware/Counter-aaaa.js">');
  });

  test("a lazy island's chunk URL travels in the payload instead", () => {
    const payload = payloadOf(document_(<Counter client:visible />));

    expect(payload.islands[0]!.on).toBe("visible");
    expect(payload.chunks).toEqual({ Counter: "/_stoneware/Counter-aaaa.js" });
  });

  test("the runtime loads only when the page has a lazy island", () => {
    const eager = scriptsIn(document_(<Counter />));
    expect(eager).not.toContain("/_stoneware/stoneware-runtime-cccc.js");

    const lazy = scriptsIn(document_(<Badge client:idle />));
    expect(lazy).toContain("/_stoneware/stoneware-runtime-cccc.js");
  });

  test("an island with both eager and lazy instances loads its chunk once, eagerly", () => {
    const html = document_(
      <div>
        <Counter start={1} />
        <Counter start={2} client:visible />
      </div>,
    );

    // One script for the island, because an eager instance already needs it.
    const scripts = scriptsIn(html);
    expect(scripts.filter((src) => src.includes("Counter-aaaa"))).toHaveLength(1);

    // And so its URL is not repeated in the payload.
    expect(payloadOf(html).chunks).toEqual({});
  });

  test("the directive is stripped before the island sees it", () => {
    // An island should never have to know a directive exists.
    const html = document_(<Counter start={7} client:idle />);
    const entry = payloadOf(html).islands[0]!;

    expect(entry.props).toEqual({ start: 7 });
    expect(html).not.toContain("client:idle");
  });

  test("client:media carries its query", () => {
    const entry = payloadOf(document_(<Counter client:media="(min-width: 60rem)" />)).islands[0]!;

    expect(entry.on).toBe("media");
    expect(entry.q).toBe("(min-width: 60rem)");
  });
});

describe("directives that cannot work", () => {
  test("an unknown directive names the valid ones", () => {
    // TypeScript rejects this first - the ts-expect-error below is the proof.
    // The runtime guard is for JavaScript users and for `{...spread}` props,
    // which no amount of typing can see into.
    // @ts-expect-error - client:lazy is not a directive
    expect(() => document_(<Counter client:lazy />)).toThrow(/unknown directive "client:lazy"/);
  });

  test("two directives on one instance is an error, not a precedence rule", () => {
    expect(() => document_(<Counter client:idle client:visible />)).toThrow(
      /two hydration directives/,
    );
  });

  test("client:media without a query is an error", () => {
    // @ts-expect-error - client:media is typed as string, so this is caught at
    // compile time too; the runtime check covers JavaScript and spreads.
    expect(() => document_(<Counter client:media />)).toThrow(/needs a media query/);
  });

  test("a directive on a plain element is an error rather than a stray attribute", () => {
    // Silently rendering it would look correct and never hydrate.
    expect(() => renderToString(<div client:visible>hi</div>)).toThrow(/only islands hydrate/);
  });

  test("a manifest with no runtime chunk explains itself", () => {
    const rendered = renderToString(<Counter client:visible />, { islands: ISLANDS });
    expect(() =>
      buildDocument({
        html: rendered.html,
        islands: rendered.islands,
        manifest: { Counter: "/_stoneware/Counter-aaaa.js" },
      }),
    ).toThrow(/manifest predates lazy hydration/);
  });
});
