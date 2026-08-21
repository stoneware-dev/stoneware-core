/**
 * The dev warning for secrets in island props.
 *
 * Everything an island receives is serialized into the page. The failure this
 * catches is passing a whole record when the island needed two fields of it -
 * `<Profile user={user} />` ships the password hash with the name, and nothing
 * about the rendered page looks wrong.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "../src/render/render.ts";
import { withRenderContext } from "../src/http/context.ts";
import { resolveConfig } from "../src/config.ts";

function Island(_props: Record<string, unknown>) {
  return <span>island</span>;
}

const islands = new Map<unknown, string>([[Island, "Island"]]);

/** Render inside a context, capturing what the framework warned about. */
function renderIn(dev: boolean, tree: Parameters<typeof renderToString>[0]): string[] {
  const captured: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => captured.push(args.map(String).join(" "));

  const config = resolveConfig({ csrf: { secret: "island-secret-test-0123456789" } }, dev);
  try {
    withRenderContext(
      {
        config,
        request: new Request("http://localhost/"),
        url: new URL("http://localhost/"),
        personalized: false,
        preloads: new Set<string>(),
        renderingHead: false,
        seoOutsideHead: false,

        caught: [],
      },
      () => renderToString(tree, { islands: islands as never }),
    );
  } finally {
    console.warn = original;
  }
  return captured;
}

// The warning fires once per island and path per process, so each test needs a
// key no other test has used.
let unique = 0;
const distinct = () => `k${unique++}`;

describe("what it catches", () => {
  test("a secret nested inside an innocuous prop", () => {
    // The realistic case, and the one a top-level key check would miss.
    const warned = renderIn(true, (
      <Island user={{ id: 1, name: "Ada", passwordHash: "$2b$10$abc" }} />
    ));

    expect(warned.join("\n")).toContain("user.passwordHash");
    expect(warned.join("\n")).toContain("sent to the browser");
  });

  test("a secret at the top level", () => {
    const warned = renderIn(true, <Island apiKey="sk_live_123" />);
    expect(warned.join("\n")).toContain("apiKey");
  });

  test("one representative element of an array, not every element", () => {
    // An array of 500 users should not produce 500 identical warnings.
    const users = Array.from({ length: 500 }, (_, i) => ({ id: i, sessionToken: "t" }));
    const warned = renderIn(true, <Island people={users} />);

    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("people[0].sessionToken");
  });
});

describe("what it deliberately ignores", () => {
  test("csrfToken, which is a documented Stoneware pattern", () => {
    // A warning that fires on correct code is one people learn to ignore.
    expect(renderIn(true, <Island csrfToken="abc" fieldName="_csrf" />)).toEqual([]);
  });

  test("ordinary props", () => {
    const warned = renderIn(true, (
      <Island title="Hello" count={3} tags={["a", "b"]} user={{ id: 1, name: "Ada" }} />
    ));
    expect(warned).toEqual([]);
  });

  test("production, where a heuristic must not cost anything", () => {
    const warned = renderIn(false, <Island password="hunter2" />);
    expect(warned).toEqual([]);
  });
});

describe("it stays out of the way", () => {
  test("it warns rather than throwing, so a heuristic cannot break a page", () => {
    const key = distinct();
    expect(() => renderIn(true, <Island {...{ [`${key}_password`]: "x" }} />)).not.toThrow();
  });

  test("the same leak is reported once, not on every request", () => {
    const props = { [`${distinct()}_secret`]: "x" };

    const first = renderIn(true, <Island {...props} />);
    const second = renderIn(true, <Island {...props} />);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  test("a deeply nested or cyclic structure cannot hang the render", () => {
    // Depth is capped, so a pathological object is walked and abandoned.
    let deep: Record<string, unknown> = { password: "leaf" };
    for (let i = 0; i < 50; i++) deep = { nested: deep };

    const started = performance.now();
    renderIn(true, <Island data={deep} />);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
