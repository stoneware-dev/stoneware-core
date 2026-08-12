/**
 * Smoke tests for the documentation site in example/.
 *
 * Deliberately thin. The framework's behavior is pinned by the fixture-based
 * tests; this file only asserts that the real site still builds, serves, and
 * upholds the claims it makes about itself — so editorial changes stay free but
 * a broken page does not ship.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/server.ts";
import { DOCS } from "../example/lib/docs.ts";
import type { KilnApp } from "../src/server.ts";

const SITE_ROOT = join(import.meta.dir, "..", "example");

let app: KilnApp;

beforeAll(async () => {
  app = await createApp(
    { root: SITE_ROOT, csrf: { secret: "docs-smoke-test-secret-0123456789" } },
    { dev: true },
  );
});

const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));

describe("pages", () => {
  test("the landing page renders with its tagline", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);

    const html = await response.text();
    expect(html).toContain("shape your web application at");
    expect(html).toContain("build/server time");
  });

  test("the docs index renders", async () => {
    expect((await get("/docs")).status).toBe(200);
  });

  test("every documented page resolves", async () => {
    for (const page of DOCS) {
      const response = await get(`/docs/${page.slug}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(page.title);
    }
  });

  test("an unknown docs slug renders a not-found page rather than erroring", async () => {
    const response = await get("/docs/nonexistent");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("No such page");
  });
});

describe("the site upholds what it documents", () => {
  const pages = ["/", "/docs", "/docs/security", "/docs/islands"];

  test("no page emits an inline style attribute, which its own CSP forbids", async () => {
    for (const path of pages) {
      const html = await (await get(path)).text();
      expect(html).not.toMatch(/<[^>]+\sstyle="/);
    }
  });

  test("no page emits inline executable script", async () => {
    for (const path of pages) {
      const html = await (await get(path)).text();
      for (const [, attributes] of html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)) {
        expect(attributes).toContain('type="application/json"');
      }
    }
  });

  test("the default CSP is served unmodified, with no unsafe directives", async () => {
    const csp = (await get("/")).headers.get("content-security-policy");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  test("the landing page ships exactly its three islands", async () => {
    const html = await (await get("/")).text();
    const islands = new Set(
      [...html.matchAll(/data-kiln-island="([^"]+)"/g)].map((match) => match[1]!),
    );
    expect([...islands].sort()).toEqual(["FiringGauge", "InstallCommand", "LiveCounter"]);
  });

  test("a docs page ships only the islands it uses", async () => {
    const html = await (await get("/docs/routing")).text();
    const islands = new Set(
      [...html.matchAll(/data-kiln-island="([^"]+)"/g)].map((match) => match[1]!),
    );
    expect([...islands].sort()).toEqual(["Feedback", "FiringGauge"]);
  });

  test("diagrams render as escaped monospace figures, not raw markup", async () => {
    const html = await (await get("/docs/how-it-works")).text();
    expect(html).toContain('<figure class="figure">');
    expect(html).toContain("<figcaption>");
    // Box-drawing survives, and the HTML inside a diagram stays inert text.
    expect(html).toContain("└");
    expect(html).toContain("&lt;button data-kiln-id=");
  });

  test("the generated project tree is documented", async () => {
    const html = await (await get("/docs/project-structure")).text();
    for (const entry of ["routes/", "islands/", "kiln.config.ts", ".env.example", "islands.json"]) {
      expect(html).toContain(entry);
    }
  });

  test("code samples are highlighted server-side, with markup escaped", async () => {
    const html = await (await get("/docs/islands")).text();
    expect(html).toContain('class="t-key"');
    // The sample contains JSX; it must render as text, not as live elements.
    expect(html).toContain("&lt;button");
  });
});

describe("feedback action", () => {
  test("rejects a submission with no CSRF token", async () => {
    const body = new FormData();
    body.append("note", "hello");
    body.append("page", "islands");

    const response = await app.fetch(
      new Request("http://localhost/api/feedback", {
        method: "POST",
        body,
        headers: { Accept: "application/json" },
      }),
    );
    expect(response.status).toBe(403);
  });

  test("accepts a submission carrying the token the page rendered", async () => {
    const html = await (await get("/docs/islands")).text();
    const token = html.match(/name="_csrf" value="([^"]+)"/)![1]!;

    const body = new FormData();
    body.append("note", "The islands page could use a diagram.");
    body.append("page", "islands");
    body.append("_csrf", token);

    const response = await app.fetch(
      new Request("http://localhost/api/feedback", {
        method: "POST",
        body,
        headers: { Accept: "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });
});
