/**
 * Async route components.
 *
 * The server awaits a route's default export before rendering starts, so that
 * one call may be async - which is what makes a database query in a route
 * possible without a data-loading API. Rendering itself is a single synchronous
 * walk to a string, so nothing deeper can be.
 *
 * The type mirrored the wrong half of that: `Component` was declared sync and
 * used for routes too, so an async route worked at runtime and failed to
 * typecheck. `PageComponent` is the route-level type; `Component` stays sync
 * because islands and nested components genuinely are.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "../src/render/render.ts";
import type { Component, PageComponent } from "../src/render/types.ts";
import type { PageProps } from "../src/routing/router.ts";

describe("the types", () => {
  test("an async route component satisfies PageComponent", () => {
    const page: PageComponent<PageProps> = async ({ params }) => {
      // Stand-in for the await a real route would do - a query, a fetch.
      const title = await Promise.resolve(params.slug ?? "home");
      return <h1>{title}</h1>;
    };

    expect(typeof page).toBe("function");
  });

  test("a sync route component still satisfies PageComponent", () => {
    const page: PageComponent<PageProps> = ({ params }) => <h1>{params.slug}</h1>;
    expect(typeof page).toBe("function");
  });

  test("Component stays synchronous", () => {
    // Islands run in the browser and nested components are called mid-walk, so
    // neither can be async. If this ever compiles as async, the constraint that
    // keeps rendering single-pass has been lost.
    const island: Component<{ n: number }> = ({ n }) => <b>{n}</b>;
    expect(typeof island).toBe("function");
  });
});

describe("rendering", () => {
  test("what an awaited async route returns renders normally", async () => {
    const page: PageComponent<{ slug: string }> = async ({ slug }) => <h1>{slug}</h1>;

    // Exactly what server.ts does: await the call, then render the result.
    const tree = await page({ slug: "hello" });
    expect(renderToString(tree).html).toBe("<h1>hello</h1>");
  });

  test("an async component nested in JSX fails with a message that names the rule", () => {
    // `any` because the JSX types correctly refuse an async component - which
    // is the point. This reaches past them to prove the runtime refuses it too,
    // for JSX written in a file the project's tsconfig does not cover.
    const Nested: any = async () => <b>too late</b>;

    expect(() => renderToString(<div><Nested /></div>)).toThrow(
      /Only a route's default export may be async/,
    );
  });

  test("the message says what to do instead", () => {
    const Nested: any = async () => <b>x</b>;
    expect(() => renderToString(<Nested />)).toThrow(/pass the result down as props/);
  });

  test("a bare promise as a child is caught the same way", () => {
    expect(() => renderToString(<div>{Promise.resolve("x") as never}</div>)).toThrow(
      /returned a promise while rendering/,
    );
  });
});

describe("through the server", () => {
  test("an async route is awaited and its markup served", async () => {
    // The end-to-end shape of a database-backed page: the route awaits, the
    // server awaits the route, and the response carries the resolved markup.
    process.env.STONEWARE_CSRF_SECRET = "async-page-test-secret-0123456789";

    const { createApp } = await import("../src/http/server.ts");
    const { join } = await import("node:path");

    const root = join(import.meta.dir, "fixture");
    const app = await createApp(
      { root },
      {
        dev: false,
        routeManifest: { "/from-db": join(root, "routes", "from-db.tsx") },
        preloadedRoutes: new Map([
          [
            "/from-db",
            {
              default: async () => {
                const row = await Promise.resolve({ title: "row from a query" });
                return <h1>{row.title}</h1>;
              },
            },
          ],
        ]),
      },
    );

    const response = await app.fetch(new Request("http://localhost/from-db"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>row from a query</h1>");
  });
});
