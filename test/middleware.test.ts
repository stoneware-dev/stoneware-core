/**
 * `routes/_middleware.ts`, CORS, and JSON error responses.
 *
 * The ordering assertions matter more than the feature: middleware runs after
 * CSRF verification and before route matching, and neither half of that is
 * arbitrary.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/server.ts";
import type { StonewareApp } from "../src/server.ts";

const FIXTURE_ROOT = join(import.meta.dir, "fixture-mw");
const SECRET = "middleware-test-secret-0123456";

let app: StonewareApp;

beforeAll(async () => {
  app = await createApp({ root: FIXTURE_ROOT, csrf: { secret: SECRET } }, { dev: true });
});

const get = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

describe("what middleware can do", () => {
  test("pass values to a page through locals", async () => {
    expect(await (await get("/?as=ada")).text()).toContain("hello ada");
  });

  test("pass the same values to an API route", async () => {
    expect(await (await get("/api/whoami?as=grace")).json()).toEqual({ user: "grace" });
  });

  test("answer the request itself and stop", async () => {
    const response = await get("/blocked");

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("blocked by middleware");
  });

  test("redirect a path that has no route at all", async () => {
    // This is why middleware runs before matching: a redirect for a page that
    // has been removed is worth nothing if it only fires for paths that resolve.
    const response = await get("/old");

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
  });
});

describe("where it sits in the pipeline", () => {
  test("a short-circuit still gets the security headers", async () => {
    // It leaves through the same single exit as everything else.
    const response = await get("/blocked");
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("it cannot see an unverified mutating request", async () => {
    // CSRF runs first, so a POST with no token is rejected before any project
    // code observes it - there is no way to middleware around the protection.
    const response = await get("/blocked", { method: "POST" });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toBe("blocked by middleware");
  });

  test("a project with no middleware is unaffected", async () => {
    const bare = await createApp(
      { root: join(import.meta.dir, "fixture"), csrf: { secret: SECRET } },
      { dev: true },
    );
    expect((await bare.fetch(new Request("http://localhost/plain"))).status).toBe(200);
  });
});

describe("JSON errors for API clients", () => {
  const asJSON = { headers: { accept: "application/json" } };

  test("a 404 is JSON, not a page", async () => {
    const response = await get("/nope", asJSON);

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: "Not Found", status: 404 });
  });

  test("a thrown handler is JSON too", async () => {
    // Previously a fetch() against a failing route resolved with a document.
    const response = await get("/api/boom", asJSON);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ status: 500 });
  });

  test("the detail is present in dev", async () => {
    const body = (await (await get("/api/boom", asJSON)).json()) as { detail?: string };
    expect(body.detail).toContain("api handler exploded");
  });

  test("production sends no detail and no stack", async () => {
    const prod = await createApp({ root: FIXTURE_ROOT, csrf: { secret: SECRET } }, { dev: false });
    const body = (await (
      await prod.fetch(new Request("http://localhost/api/boom", asJSON))
    ).json()) as Record<string, unknown>;

    expect(body.detail).toBeUndefined();
    expect(body.stack).toBeUndefined();
  });

  test("a browser navigation still gets the HTML page", async () => {
    // Decided from Accept, not from the path: /api/* reached by a navigation is
    // still a navigation.
    const response = await get("/nope", { headers: { accept: "text/html" } });
    expect(response.headers.get("Content-Type")).toContain("text/html");
  });
});

describe("CORS", () => {
  const origin = "https://caller.test";

  test("off by default, so nothing is added", async () => {
    const response = await get("/", { headers: { origin } });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("an allowed origin is echoed, and the response varies on it", async () => {
    const cors = await createApp(
      { root: FIXTURE_ROOT, csrf: { secret: SECRET }, cors: { origin: [origin] } },
      { dev: true },
    );
    const response = await cors.fetch(new Request("http://localhost/", { headers: { origin } }));

    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    // Without Vary a shared cache can hand one origin's response to another.
    expect(response.headers.get("Vary")).toContain("Origin");
  });

  test("an origin not on the list gets no header at all", async () => {
    const cors = await createApp(
      { root: FIXTURE_ROOT, csrf: { secret: SECRET }, cors: { origin: [origin] } },
      { dev: true },
    );
    const response = await cors.fetch(
      new Request("http://localhost/", { headers: { origin: "https://evil.test" } }),
    );

    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("a preflight is answered without a CSRF token", async () => {
    // The browser sends OPTIONS with no body and no token by design, and will
    // not send the real request until this succeeds.
    const cors = await createApp(
      { root: FIXTURE_ROOT, csrf: { secret: SECRET }, cors: { origin: "*" } },
      { dev: true },
    );
    const response = await cors.fetch(
      new Request("http://localhost/api/whoami", {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST" },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("x-csrf-token");
  });

  test("a real cross-origin POST still needs its CSRF token", async () => {
    // CORS decides who may read a response. It does not decide who may act.
    const cors = await createApp(
      { root: FIXTURE_ROOT, csrf: { secret: SECRET }, cors: { origin: "*" } },
      { dev: true },
    );
    const response = await cors.fetch(
      new Request("http://localhost/api/whoami", { method: "POST", headers: { origin } }),
    );

    expect(response.status).toBe(403);
  });

  test('origin "*" with credentials is refused at config time', () => {
    // The browser rejects the pairing outright; failing here names the problem.
    expect(() =>
      createApp(
        {
          root: FIXTURE_ROOT,
          csrf: { secret: SECRET },
          cors: { origin: "*", credentials: true },
        },
        { dev: true },
      ),
    ).toThrow(/cannot be combined with cors.credentials/);
  });
});
