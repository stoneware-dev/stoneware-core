/**
 * Two failure modes that used to be silent or cryptic.
 *
 * Both are development-experience bugs rather than correctness bugs, which is
 * exactly why they are worth a test: nothing else would notice if the message
 * regressed back to being unhelpful.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderToString } from "../src/render/render.ts";
import { createApp } from "../src/http/server.ts";
import type { StonewareApp } from "../src/http/server.ts";

describe("JSX compiled against the wrong runtime", () => {
  /** What React's JSX transform produces, as the renderer would receive it. */
  const reactElement = {
    $$typeof: Symbol.for("react.element"),
    type: "div",
    props: { children: "hi" },
    key: null,
  };

  test("says which compiler option is wrong", () => {
    // Previously: "Cannot render value of type object", which sends people to
    // look at their data instead of their tsconfig.
    expect(() => renderToString(reactElement as never)).toThrow(/jsxImportSource/);
  });

  test("names Stoneware rather than just complaining", () => {
    expect(() => renderToString(reactElement as never)).toThrow(/React's runtime, not Stoneware's/);
  });

  test("recognises React 19's renamed brand too", () => {
    // The symbol changed in React 19; missing it would restore the old message.
    const react19 = { ...reactElement, $$typeof: Symbol.for("react.transitional.element") };
    expect(() => renderToString(react19 as never)).toThrow(/jsxImportSource/);
  });

  test("an ordinary object still gets the ordinary error", () => {
    // The point of this test is the negative: an object that is not a React
    // element must not be blamed on the JSX runtime. The wording moved when the
    // message started naming the value, so it is matched on what it must say
    // rather than on the sentence it used to be.
    expect(() => renderToString({ nope: true } as never)).toThrow(/Cannot render a plain object/);
    expect(() => renderToString({ nope: true } as never)).not.toThrow(/jsxImportSource/);
  });
});

describe("seo() called outside head", () => {
  const FIXTURE_ROOT = join(import.meta.dir, "fixture-seo");
  let app: StonewareApp;
  let warnings: string[];

  beforeAll(async () => {
    app = await createApp(
      { root: FIXTURE_ROOT, csrf: { secret: "diagnostics-secret-0123456789" } },
      { dev: true },
    );
  });

  /** Capture console.warn for one request. */
  async function warningsFor(path: string): Promise<string[]> {
    warnings = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      await app.fetch(new Request(`http://localhost${path}`));
    } finally {
      console.warn = original;
    }
    return warnings;
  }

  test("warns when the tags would land in <body>", async () => {
    // A page using the framework's shell: seo() in the body renders <title>
    // into <body>, where nothing reads it.
    const warned = await warningsFor("/stranded");

    expect(warned.join("\n")).toContain("seo() was called while rendering");
    expect(warned.join("\n")).toContain("head export");
  });

  test("says nothing when seo() is used from head", async () => {
    expect(await warningsFor("/correct")).toEqual([]);
  });

  test("says nothing when the page owns its own document", async () => {
    // Calling seo() inside your own <head> is legitimate, so warning there
    // would be a false positive.
    expect(await warningsFor("/full-document")).toEqual([]);
  });

  test("stays quiet in production", async () => {
    const prod = await createApp(
      { root: FIXTURE_ROOT, csrf: { secret: "diagnostics-secret-0123456789" } },
      { dev: false },
    );

    const captured: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    try {
      await prod.fetch(new Request("http://localhost/stranded"));
    } finally {
      console.warn = original;
    }

    expect(captured).toEqual([]);
  });
});
