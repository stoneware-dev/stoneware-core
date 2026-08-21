/**
 * Which component supplied the value the renderer could not render.
 *
 * The renderer is a depth-first walk, so a stack trace from inside it is all
 * renderer: `renderChild` called by `renderElement`, over and over, naming the
 * mechanism and not one line of the project's own code. The walk knows the
 * answer on the way in and the error happens on the way out, so each frame
 * records its own name as the error unwinds.
 *
 * Two properties matter and neither is about formatting. The path has to be
 * accurate - a wrong component name is worse than none, because it sends
 * someone to the wrong file. And an error thrown by project code has to keep
 * its own message: the framework may annotate its own errors, never yours.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "../src/render/render.ts";
import { componentPathOf } from "../src/render/errors.ts";
import { Boundary } from "../src/helpers/boundary.tsx";
import { isNotFound, notFound } from "../src/helpers/not-found.ts";
import { join } from "node:path";

/** The message of whatever `fn` throws. */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
}

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

const PRODUCT = { id: 1, title: "Widget", price: 9.99 };

function Price({ product }: { product: unknown }) {
  return <span>{product as never}</span>;
}

function ProductCard({ product }: { product: unknown }) {
  return (
    <div class="card">
      <Price product={product} />
    </div>
  );
}

function Home() {
  return (
    <main>
      <ProductCard product={PRODUCT} />
    </main>
  );
}

describe("the path names the components, innermost first", () => {
  test("every component, plus the element the value landed in", () => {
    const message = messageOf(() => renderToString(<Home />));

    // Innermost first: the span is where the value actually landed, and Home is
    // only useful as the far end of the trail.
    expect(message).toContain("  in <span>");
    expect(message).toContain("  in <Price>");
    expect(message).toContain("  in <ProductCard>");
    expect(message).toContain("  in <Home>");

    expect(message.indexOf("in <span>")).toBeLessThan(message.indexOf("in <Price>"));
    expect(message.indexOf("in <Price>")).toBeLessThan(message.indexOf("in <Home>"));
  });

  test("intermediate elements are deliberately left out", () => {
    // Only the innermost element is named. Recording every ancestor element
    // meant a try/catch per element, which measured 38% of a full page render -
    // and the component names already cover that ground. This asserts the
    // trade rather than leaving it to be reintroduced by accident.
    const message = messageOf(() => renderToString(<Home />));
    expect(message).not.toContain("in <div>");
    expect(message).not.toContain("in <main>");
  });

  test("an element frame is recorded even with no component involved", () => {
    // A bare object interpolated straight into markup. The element is then the
    // only frame there is, and it still has to be reported.
    const message = messageOf(() => renderToString(<div>{PRODUCT as never}</div>));
    expect(message).toContain("in <div>");
  });

  test("the path is readable through the public helper too", () => {
    const path = componentPathOf(thrownBy(() => renderToString(<Home />)));
    expect(path?.[0]).toBe("<span>");
    expect(path).toContain("<ProductCard>");
  });

  test("deeply nested components do not append a hundred frames", () => {
    // Layouts nest, and a path that ran to sixty entries would bury the frames
    // that identify the problem under the ones that do not.
    function Nest({ depth, children }: { depth: number; children?: unknown }) {
      return depth === 0 ? (
        <span>{children as never}</span>
      ) : (
        <Nest depth={depth - 1}>{children as never}</Nest>
      );
    }

    const tree = <Nest depth={60}>{PRODUCT as never}</Nest>;

    const path = componentPathOf(thrownBy(() => renderToString(tree as never)))!;
    expect(path.length).toBeLessThanOrEqual(12);
    expect(messageOf(() => renderToString(tree as never))).toContain("outer frames omitted");
  });
});

describe("the message names what the value was", () => {
  test("a plain object lists its keys", () => {
    // "type object" is equally true of a Date, a row and a Map, and each needs
    // something different done to it. Keys rather than values: enough to
    // recognise a product row without putting its contents in a log.
    const message = messageOf(() => renderToString(<Home />));
    expect(message).toContain("plain object with keys: id, title, price");
    expect(message).not.toContain("Widget");
  });

  test("a Date says so, and says what to do", () => {
    const message = messageOf(() => renderToString(<p>{new Date() as never}</p>));
    expect(message).toContain("a Date");
    expect(message).toContain("toISOString");
  });

  test("a Map or Set says so", () => {
    expect(messageOf(() => renderToString(<p>{new Map([["a", 1]]) as never}</p>))).toContain(
      "a Map of size 1",
    );
    expect(messageOf(() => renderToString(<p>{new Set([1, 2]) as never}</p>))).toContain(
      "a Set of size 2",
    );
  });

  test("a class instance is named by its class", () => {
    class Money {
      constructor(readonly amount: number) {}
    }
    expect(messageOf(() => renderToString(<p>{new Money(5) as never}</p>))).toContain(
      "an instance of Money",
    );
  });

  test("many keys are truncated rather than dumped", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 20; i++) wide[`field${i}`] = i;

    const message = messageOf(() => renderToString(<p>{wide as never}</p>));
    expect(message).toContain("(20 keys)");
  });
});

describe("an error from project code is not rewritten", () => {
  test("its message survives exactly", () => {
    function Broken(): never {
      throw new Error("connection to db-primary refused");
    }

    const error = thrownBy(() => renderToString(<main><Broken /></main>)) as Error;

    // The framework annotates its own errors. Someone else's error keeps the
    // words it was thrown with - a driver's stack must not come back with
    // framework prose appended.
    expect(error.message).toBe("connection to db-primary refused");
  });

  test("but the path is still attached for the server to log", () => {
    function Broken(): never {
      throw new Error("connection to db-primary refused");
    }

    const path = componentPathOf(thrownBy(() => renderToString(<main><Broken /></main>)));
    expect(path).toContain("<Broken>");
  });
});

describe("interaction with the other error paths", () => {
  test("notFound() is not annotated on its way out", () => {
    // It is a routing decision travelling as an exception, and the server
    // matches on it. Rewriting its message would be the least of the damage.
    function Missing() {
      notFound("no such post");
      return null;
    }

    const error = thrownBy(() => renderToString(<main><Missing /></main>));
    expect(isNotFound(error)).toBe(true);
    expect((error as Error).message).toBe("no such post");
  });

  test("a boundary's console line carries the finished path", () => {
    // A boundary is a second exit from the walk, and its console line is the
    // only place the caught error is ever seen.
    const seen: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      seen.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    };

    try {
      renderToString(
        <Boundary fallback={<p>unavailable</p>}>
          <ProductCard product={PRODUCT} />
        </Boundary>,
      );
    } finally {
      console.error = original;
    }

    expect(seen.join("\n")).toContain("in <Price>");
  });

  test("the message is not annotated twice", () => {
    const message = messageOf(() => renderToString(<Home />));
    expect(message.match(/in <Price>/g)).toHaveLength(1);
  });
});

describe("when routes/_500.tsx fails the same way", () => {
  // Two errors are then in play and they look almost identical: both are
  // "cannot render an object", both come from inside the renderer. Telling them
  // apart is the whole difficulty, and the one worth keeping is the original.
  const ROOT = join(import.meta.dir, "fixture-error-attribution");

  test("the built-in page shows the original error, not the error page's", async () => {
    const { createApp } = await import("../src/http/server.ts");
    const app = await createApp(
      { root: ROOT, csrf: { secret: "attribution-secret-0123456789" } },
      { dev: true },
    );

    const seen: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      seen.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    };

    let html: string;
    let status: number;
    try {
      const response = await app.fetch(new Request("http://localhost/"));
      status = response.status;
      html = await response.text();
    } finally {
      console.error = original;
    }

    expect(status).toBe(500);

    // The page a developer is looking at describes what actually broke, not the
    // error page's own unrelated failure.
    expect(html).toContain("id, title, price");
    expect(html).not.toContain("theme, locale");

    const log = seen.join("\n");
    // And the log says which error is which, rather than printing two similar
    // stacks and leaving them to be told apart by eye.
    expect(log).toContain("threw while rendering the error page");
    expect(log).toContain("not the one that caused the 500");
    expect(log).toContain("The original error, which is what the 500 was actually for");

    // Both paths are reported, and they name different components.
    expect(log).toContain("<Price>");
    expect(log).toContain("<Banner>");
  });
});
