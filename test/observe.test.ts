/**
 * The `observe` hook.
 *
 * Two things here are worth more than the plumbing.
 *
 * The first is `route`: the matched *pattern*, not the path. That is the only
 * field a project could not have produced for itself with a middleware, and it
 * is the one that decides whether a dashboard has a row per route or a row per
 * blog post. If it ever starts reporting the concrete path, this is meant to be
 * the test that says so.
 *
 * The second is that an observer cannot damage the request. It runs on the
 * request's own path, so a hook that threw - or returned a promise that
 * rejected - would otherwise turn a working page into a 500 for a reason that
 * has nothing to do with the page.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/server.ts";
import { consoleObserver, formatEvent } from "../src/observe.ts";
import type { RequestEvent } from "../src/observe.ts";
import type { StonewareApp } from "../src/server.ts";

const FIXTURE = join(import.meta.dir, "fixture");
const MW_FIXTURE = join(import.meta.dir, "fixture-mw");
const ERROR_FIXTURE = join(import.meta.dir, "fixture-errors-bare");
const SECRET = "observe-test-secret-0123456789";

/** Events from the most recent request, cleared before each one. */
let seen: RequestEvent[] = [];
let app: StonewareApp;

beforeAll(async () => {
  app = await createApp(
    {
      root: FIXTURE,
      csrf: { secret: SECRET },
      observe: (event) => {
        seen.push(event);
      },
    },
    { dev: true },
  );
});

/** Make one request and return the single event it produced. */
async function trace(path: string, init?: RequestInit): Promise<RequestEvent> {
  seen = [];
  await app.fetch(new Request(`http://localhost${path}`, init));
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

describe("what the hook is handed", () => {
  test("one event per request", async () => {
    seen = [];
    await app.fetch(new Request("http://localhost/plain"));
    await app.fetch(new Request("http://localhost/plain"));
    expect(seen).toHaveLength(2);
  });

  test("the status actually sent", async () => {
    expect((await trace("/plain")).status).toBe(200);
    expect((await trace("/nothing-here")).status).toBe(404);
  });

  test("the method, unmodified", async () => {
    expect((await trace("/plain", { method: "HEAD" })).method).toBe("HEAD");
  });

  test("a duration that is measured, not rounded away", async () => {
    const event = await trace("/plain");
    // A static render is routinely faster than a millisecond, so the useful
    // assertion is that it is a real float rather than an integer count.
    expect(event.durationMs).toBeGreaterThan(0);
    expect(Number.isFinite(event.durationMs)).toBe(true);
  });

  test("the same URL the route saw", async () => {
    const event = await trace("/plain?ref=newsletter");
    expect(event.url.pathname).toBe("/plain");
    expect(event.url.searchParams.get("ref")).toBe("newsletter");
  });
});

describe("route is the pattern, not the path", () => {
  test("a dynamic route reports its pattern", async () => {
    // The whole argument for this living in the framework. Middleware runs
    // before matching and could only ever report "/blog/hello-world".
    const event = await trace("/blog/hello-world");
    expect(event.route).toBe("/blog/[slug]");
    expect(event.url.pathname).toBe("/blog/hello-world");
  });

  test("a static route reports itself", async () => {
    expect((await trace("/plain")).route).toBe("/plain");
  });

  test("nothing matched means no pattern to report", async () => {
    expect((await trace("/nothing-here")).route).toBeNull();
  });
});

describe("kind says what answered", () => {
  test("a page", async () => {
    expect((await trace("/plain")).kind).toBe("page");
  });

  test("an action, even when the method is wrong for it", async () => {
    // GET on a POST-only route is a 405 from the action layer, not a 404 - and
    // it is safe, so it gets there without a CSRF token.
    const event = await trace("/api/echo");
    expect(event.kind).toBe("action");
    expect(event.route).toBe("/api/echo");
    expect(event.status).toBe(405);
  });

  test("a file from public/", async () => {
    const event = await trace("/styles.css");
    expect(event.kind).toBe("asset");
    expect(event.status).toBe(200);
  });

  test("a built island chunk", async () => {
    const chunk = Object.values(app.islandManifest)[0]!;
    expect((await trace(chunk)).kind).toBe("asset");
  });

  test("an unmatched path", async () => {
    expect((await trace("/nothing-here")).kind).toBe("not-found");
  });

  test("a CSRF rejection is not an application error", async () => {
    // Kept apart from "error" deliberately: a rise in these is a security
    // signal - a stale form, a broken proxy, or someone trying - and folding
    // them into the 5xx rate hides all three.
    const event = await trace("/api/echo", { method: "POST" });
    expect(event.kind).toBe("rejected");
    expect(event.status).toBe(403);
    // Rejected before matching, so there is no pattern to report.
    expect(event.route).toBeNull();
  });

  test("a page that renders 404 is still a page", async () => {
    // The route matched and chose the status. Reporting it as "not-found" would
    // lose the one fact worth having: which route produced it.
    const event = await trace("/blog/anything");
    expect(event.kind).toBe("page");
    expect(event.route).toBe("/blog/[slug]");
  });
});

describe("kinds that need another project shape", () => {
  test("middleware answering instead of the route", async () => {
    const events: RequestEvent[] = [];
    const mw = await createApp(
      {
        root: MW_FIXTURE,
        csrf: { secret: SECRET },
        observe: (event) => {
          events.push(event);
        },
      },
      { dev: true },
    );

    await mw.fetch(new Request("http://localhost/blocked"));
    expect(events[0]!.kind).toBe("middleware");
    expect(events[0]!.status).toBe(403);
  });

  test("a route that throws", async () => {
    const events: RequestEvent[] = [];
    const failing = await createApp(
      {
        root: ERROR_FIXTURE,
        csrf: { secret: SECRET },
        observe: (event) => {
          events.push(event);
        },
      },
      { dev: true },
    );

    await failing.fetch(new Request("http://localhost/boom"));

    expect(events[0]!.kind).toBe("error");
    expect(events[0]!.status).toBe(500);
    // The thrown value itself, so a reporter can send the stack rather than a
    // message the framework has already flattened into a string.
    expect(events[0]!.error).toBeInstanceOf(Error);
  });
});

describe("an observer cannot damage the request", () => {
  test("one that throws leaves the response alone", async () => {
    const app = await createApp(
      {
        root: FIXTURE,
        csrf: { secret: SECRET },
        observe: () => {
          throw new Error("observer is broken");
        },
      },
      { dev: true },
    );

    const response = await app.fetch(new Request("http://localhost/plain"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<!DOCTYPE html>");
  });

  test("an async one is never awaited, and its rejection is absorbed", async () => {
    let settled = false;
    const app = await createApp(
      {
        root: FIXTURE,
        csrf: { secret: SECRET },
        observe: async () => {
          await Bun.sleep(50);
          settled = true;
          throw new Error("reporting backend is down");
        },
      },
      { dev: true },
    );

    const response = await app.fetch(new Request("http://localhost/plain"));

    expect(response.status).toBe(200);
    // Still in flight: the request did not wait for it. If this ever starts
    // being awaited, every response inherits the latency of the metrics backend.
    expect(settled).toBe(false);

    // Let it reject, and confirm that alone does not fail the test run.
    await Bun.sleep(80);
    expect(settled).toBe(true);
  });

  test("no observer configured is not a code path at all", async () => {
    const app = await createApp({ root: FIXTURE, csrf: { secret: SECRET } }, { dev: true });
    expect((await app.fetch(new Request("http://localhost/plain"))).status).toBe(200);
  });
});

describe("the built-in console observer", () => {
  function capture(observer: ReturnType<typeof consoleObserver>, event: RequestEvent): string[] {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      observer(event);
    } finally {
      Object.assign(console, original);
    }
    return lines;
  }

  const event = (overrides: Partial<RequestEvent> = {}): RequestEvent => ({
    request: new Request("http://localhost/blog/hello"),
    url: new URL("http://localhost/blog/hello"),
    method: "GET",
    kind: "page",
    route: "/blog/[slug]",
    status: 200,
    durationMs: 3.14159,
    ...overrides,
  });

  test("one line per request", () => {
    expect(capture(consoleObserver(), event())).toHaveLength(1);
  });

  test("assets are skipped by default", () => {
    // One page load is one page request and then every asset on it. Including
    // them by default turns the log into something nobody reads.
    expect(capture(consoleObserver(), event({ kind: "asset" }))).toHaveLength(0);
    expect(capture(consoleObserver({ assets: true }), event({ kind: "asset" }))).toHaveLength(1);
  });

  test("the line carries status, method, path and duration", () => {
    const [line] = capture(consoleObserver(), event());
    expect(line).toContain("200");
    expect(line).toContain("GET");
    expect(line).toContain("/blog/hello");
    expect(line).toContain("3.1ms");
  });

  test("the pattern appears only when it differs from the path", () => {
    expect(formatEvent(event())).toContain("/blog/[slug]");

    const plain = formatEvent(
      event({
        url: new URL("http://localhost/about"),
        route: "/about",
      }),
    );
    // Printing "/about  /about" is noise.
    expect(plain.match(/\/about/g)).toHaveLength(1);
  });

  test("sub-millisecond renders are not reported as zero", () => {
    // The framework's whole claim is that this path is fast. Rounding it to an
    // integer would print "0ms" and make it look unmeasurable.
    expect(formatEvent(event({ durationMs: 0.42 }))).toContain("0.4ms");
    expect(formatEvent(event({ durationMs: 128.6 }))).toContain("129ms");
  });

  test("an error is named on the line", () => {
    const line = formatEvent(
      event({ kind: "error", status: 500, error: new TypeError("x is not a function") }),
    );
    expect(line).toContain("TypeError: x is not a function");
  });
});
