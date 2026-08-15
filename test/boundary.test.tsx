/**
 * `<Boundary>` - one failing subtree instead of one failing page.
 *
 * The interesting cases are not "does it catch". They are the three things a
 * boundary can get wrong while appearing to work:
 *
 *   - swallowing `notFound()`, which turns a routing decision into a soft 404
 *   - leaving a discarded subtree's island in the hydration payload, so the
 *     client hunts for a marker that is not on the page
 *   - absorbing an error so completely that nothing anywhere can see it
 */

import { describe, expect, test } from "bun:test";
import { Boundary } from "../src/boundary.tsx";
import { withRenderContext } from "../src/context.ts";
import { notFound } from "../src/not-found.ts";
import { renderToString } from "../src/render.ts";
import { resolveConfig } from "../src/config.ts";
import type { RenderContext } from "../src/context.ts";

const SECRET = "boundary-test-secret-0123456789";

function Boom(): never {
  throw new Error("the widget failed");
}

/** Silence the deliberate console.error these tests provoke. */
function quiet<T>(fn: () => T): T {
  const original = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = original;
  }
}

function context(dev: boolean): RenderContext {
  return {
    config: resolveConfig({ root: process.cwd(), csrf: { secret: SECRET } }, dev),
    request: new Request("http://localhost/"),
    url: new URL("http://localhost/"),
    personalized: false,
    preloads: new Set<string>(),
    renderingHead: false,
    seoOutsideHead: false,
    caught: [],
  };
}

describe("catching", () => {
  test("a throwing child is replaced by the fallback", () => {
    const html = quiet(
      () =>
        renderToString(
          <main>
            <Boundary fallback={<p>unavailable</p>}>
              <Boom />
            </Boundary>
          </main>,
        ).html,
    );

    expect(html).toBe("<main><p>unavailable</p></main>");
  });

  test("the rest of the page is untouched", () => {
    // The whole point: the article survives the widget.
    const html = quiet(
      () =>
        renderToString(
          <main>
            <h1>Still here</h1>
            <Boundary fallback={<p>unavailable</p>}>
              <Boom />
            </Boundary>
            <footer>and here</footer>
          </main>,
        ).html,
    );

    expect(html).toContain("Still here");
    expect(html).toContain("and here");
    expect(html).toContain("unavailable");
  });

  test("nothing is caught when nothing throws", () => {
    const html = renderToString(
      <Boundary fallback={<p>unavailable</p>}>
        <p>fine</p>
      </Boundary>,
    ).html;

    expect(html).toBe("<p>fine</p>");
  });

  test("a partially rendered subtree leaves nothing behind", () => {
    // The failure happens after some markup has been produced. None of it may
    // reach the output, or the page carries half a widget.
    function Half() {
      return (
        <div>
          <span>first</span>
          <Boom />
        </div>
      );
    }

    const html = quiet(
      () => renderToString(<Boundary fallback={<p>gone</p>}>{<Half />}</Boundary>).html,
    );

    expect(html).toBe("<p>gone</p>");
    expect(html).not.toContain("first");
  });

  test("boundaries nest, and the innermost one wins", () => {
    const html = quiet(
      () =>
        renderToString(
          <Boundary fallback={<p>outer</p>}>
            <section>
              <Boundary fallback={<p>inner</p>}>
                <Boom />
              </Boundary>
            </section>
          </Boundary>,
        ).html,
    );

    expect(html).toBe("<section><p>inner</p></section>");
  });

  test("a fallback that throws is not caught by its own boundary", () => {
    // Otherwise this recurses. It propagates to the route's _500 instead.
    expect(() =>
      quiet(() =>
        renderToString(
          <Boundary fallback={<Boom />}>
            <Boom />
          </Boundary>,
        ),
      ),
    ).toThrow(/the widget failed/);
  });
});

describe("what a boundary must not catch", () => {
  test("notFound() passes straight through", () => {
    // A routing decision travelling as an exception. Swallowing it would render
    // the fallback with a 200 - a soft 404, which is the bug 0.1.3 removed.
    function Missing(): never {
      notFound("no such post");
    }

    expect(() =>
      renderToString(
        <Boundary fallback={<p>unavailable</p>}>
          <Missing />
        </Boundary>,
      ),
    ).toThrow(/no such post/);
  });

  test("notFound() from inside nested boundaries still escapes", () => {
    function Missing(): never {
      notFound();
    }

    expect(() =>
      renderToString(
        <Boundary fallback={<p>outer</p>}>
          <Boundary fallback={<p>inner</p>}>
            <Missing />
          </Boundary>
        </Boundary>,
      ),
    ).toThrow();
  });
});

describe("nothing is absorbed silently", () => {
  test("the error reaches the console", () => {
    const seen: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => seen.push(args);
    try {
      renderToString(
        <Boundary fallback={<p>unavailable</p>}>
          <Boom />
        </Boundary>,
      );
    } finally {
      console.error = original;
    }

    // With no observe hook configured - the production default - this is the
    // only thing between a caught error and complete silence.
    expect(seen).toHaveLength(1);
    expect(String(seen[0])).toContain("the widget failed");
  });

  test("the error is recorded on the render context", () => {
    const ctx = context(false);

    quiet(() =>
      withRenderContext(ctx, () =>
        renderToString(
          <Boundary fallback={<p>unavailable</p>}>
            <Boom />
          </Boundary>,
        ),
      ),
    );

    // This is what carries it out to the observe hook, so a reporting backend
    // gets the thrown value rather than a formatted console line.
    expect(ctx.caught).toHaveLength(1);
    expect((ctx.caught[0] as Error).message).toBe("the widget failed");
  });
});

describe("the fallback as a function", () => {
  test("receives the error in development", () => {
    const html = quiet(
      () =>
        withRenderContext(context(true), () =>
          renderToString(
            <Boundary fallback={({ error }) => <pre>{(error as Error).message}</pre>}>
              <Boom />
            </Boundary>,
          ),
        ).html,
    );

    expect(html).toBe("<pre>the widget failed</pre>");
  });

  test("receives nothing in production", () => {
    // Same contract routes/_500.tsx already has: an exception message routinely
    // carries a file path, a query or a connection string, and a fallback is
    // rendered into a page a visitor reads.
    const html = quiet(
      () =>
        withRenderContext(context(false), () =>
          renderToString(
            <Boundary fallback={({ error }) => <pre>{error === undefined ? "hidden" : "LEAKED"}</pre>}>
              <Boom />
            </Boundary>,
          ),
        ).html,
    );

    expect(html).toBe("<pre>hidden</pre>");
  });
});

describe("islands inside a discarded subtree", () => {
  function Widget() {
    return <span>widget</span>;
  }

  function BrokenAfterIsland() {
    return (
      <div>
        <Widget />
        <Boom />
      </div>
    );
  }

  test("are removed from the hydration payload", () => {
    // An island registered before the throw would otherwise be named in the
    // payload with no element on the page - the client runtime would warn about
    // a marker it cannot find, on a page that looks perfectly fine.
    const islands = new Map([[Widget as never, "Widget"]]);

    const result = quiet(() =>
      renderToString(
        <Boundary fallback={<p>gone</p>}>
          <BrokenAfterIsland />
        </Boundary>,
        { islands },
      ),
    );

    expect(result.html).toBe("<p>gone</p>");
    expect(result.islands).toHaveLength(0);
  });

  test("an island outside the boundary is kept, and ids stay consistent", () => {
    const islands = new Map([[Widget as never, "Widget"]]);

    const result = quiet(() =>
      renderToString(
        <main>
          <Widget />
          <Boundary fallback={<p>gone</p>}>
            <BrokenAfterIsland />
          </Boundary>
          <Widget />
        </main>,
        { islands },
      ),
    );

    expect(result.islands).toHaveLength(2);
    // Ids are positional, so the discarded one's index is reused rather than
    // skipped - and every id in the payload must match a marker in the markup.
    for (const island of result.islands) {
      expect(result.html).toContain(`data-stoneware-id="${island.id}"`);
    }
    expect(new Set(result.islands.map((i) => i.id)).size).toBe(2);
  });
});
