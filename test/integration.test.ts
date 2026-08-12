/**
 * Integration tests: request in, expected HTML out (CLAUDE.md §15).
 *
 * One block per v0.1 milestone, run against the worked example so the example
 * itself stays honest.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/server.ts";
import type { KilnApp } from "../src/server.ts";

const EXAMPLE_ROOT = join(import.meta.dir, "..", "example");
const SECRET = "integration-test-secret-0123456789";

let app: KilnApp;

beforeAll(async () => {
  app = await createApp({ root: EXAMPLE_ROOT, csrf: { secret: SECRET } }, { dev: true });
});

const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));

async function getHTML(path: string): Promise<string> {
  return await (await get(path)).text();
}

/** Pull a live CSRF token out of the rendered homepage. */
async function freshToken(): Promise<string> {
  const html = await getHTML("/");
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error("Homepage did not render a CSRF token");
  return match[1]!;
}

describe("milestone 1 - static SSR", () => {
  test("renders a complete HTML document", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const html = await response.text();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>kiln - a Bun-native SSR framework</title>");
    expect(html).toContain("</html>");
  });

  test("renders dynamic route params", async () => {
    const html = await getHTML("/blog/islands");
    expect(html).toContain("<h1>Islands, and where the boundary goes</h1>");
  });

  test("a route can handle its own not-found case", async () => {
    expect(await getHTML("/blog/nonexistent")).toContain("<h1>No such post</h1>");
  });

  test("unmatched paths 404", async () => {
    expect((await get("/no/such/page")).status).toBe(404);
  });

  test("serves files from public/ as-is", async () => {
    const response = await get("/styles.css");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("--accent");
  });

  test("refuses path traversal out of the asset directories", async () => {
    expect((await get("/_kiln/..%2f..%2fpackage.json")).status).toBe(404);
  });
});

describe("milestone 2 - islands", () => {
  test("islands are server-rendered with real content, not placeholders", async () => {
    const html = await getHTML("/");
    expect(html).toContain('data-kiln-island="Counter"');
    expect(html).toContain("Clicked 0 times");
    expect(html).toContain("readers subscribed");
  });

  test("each island on the page gets exactly one module script", async () => {
    const html = await getHTML("/");
    const scripts = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)];
    const sources = scripts.map((match) => match[1]!);

    expect(sources).toHaveLength(3);
    expect(new Set(sources).size).toBe(3);
    for (const source of sources) expect(source.startsWith("/_kiln/")).toBe(true);
  });

  test("built island chunks are served", async () => {
    const source = app.islandManifest.Counter!;
    const response = await get(source);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hydrate");
  });

  test("a page with no islands ships no JavaScript at all", async () => {
    const html = await getHTML("/about");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("/_kiln/");
  });
});

describe("milestone 3 - signals", () => {
  test("island props reach the client as escaped JSON", async () => {
    const html = await getHTML("/");
    const payload = html.match(
      /<script type="application\/json" id="kiln-islands">(.*?)<\/script>/s,
    )?.[1];

    expect(payload).toBeDefined();
    const parsed = JSON.parse(payload!) as { name: string; id: string; props: object }[];
    expect(parsed.map((entry) => entry.name)).toEqual([
      "SubscriberBadge",
      "Counter",
      "Newsletter",
    ]);
    expect(parsed.every((entry) => typeof entry.id === "string")).toBe(true);
  });

  test("a shared signal is bundled once, into a chunk both islands import", async () => {
    const newsletter = await (await get(app.islandManifest.Newsletter!)).text();
    const badge = await (await get(app.islandManifest.SubscriberBadge!)).text();

    const chunkOf = (source: string): string[] =>
      source.match(/from\s*"\.\/(chunk-[^"]+\.js)"/g) ?? [];
    const shared = chunkOf(newsletter).filter((chunk) => chunkOf(badge).includes(chunk));

    expect(shared.length).toBeGreaterThan(0);
  });
});

describe("milestone 4 - server actions and CSRF", () => {
  async function post(fields: Record<string, string>, headers: Record<string, string> = {}) {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, value);
    return app.fetch(
      new Request("http://localhost/api/subscribe", {
        method: "POST",
        body,
        headers: { Accept: "application/json", ...headers },
      }),
    );
  }

  test("<Form> injects a hidden CSRF field with no configuration", async () => {
    const html = await getHTML("/");
    expect(html).toMatch(/<input type="hidden" name="_csrf" value="[^"]+">/);
  });

  test("a valid token reaches the handler", async () => {
    const response = await post({ email: "reader@example.com", _csrf: await freshToken() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  test("the handler receives an unconsumed request body", async () => {
    const response = await post({ email: "body@example.com", _csrf: await freshToken() });
    expect(await response.json()).toMatchObject({ ok: true });
  });

  test("a missing token is rejected before the handler runs", async () => {
    const response = await post({ email: "attacker@example.com" });
    expect(response.status).toBe(403);
  });

  test("a forged token is rejected", async () => {
    const response = await post({ email: "a@b.com", _csrf: "forged" });
    expect(response.status).toBe(403);
  });

  test("islands can send the token as a header instead", async () => {
    const response = await post({ email: "header@example.com" }, { "x-csrf-token": await freshToken() });
    expect(response.status).toBe(200);
  });

  test("an action rejects methods it does not export", async () => {
    const response = await get("/api/subscribe");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  test("a page route rejects POST", async () => {
    const body = new FormData();
    body.append("_csrf", await freshToken());
    const response = await app.fetch(
      new Request("http://localhost/about", { method: "POST", body }),
    );
    expect(response.status).toBe(405);
  });
});

describe("milestone 5 - security defaults", () => {
  test("every HTML response carries a CSP with no unsafe directives", async () => {
    for (const path of ["/", "/about", "/blog/islands", "/no/such/page"]) {
      const csp = (await get(path)).headers.get("content-security-policy");
      expect(csp).toBeTruthy();
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
    }
  });

  test("server action responses are covered too", async () => {
    const response = await get("/api/subscribe"); // 405, still a response
    expect(response.headers.get("content-security-policy")).toBeTruthy();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("the standard hardening headers are present", async () => {
    const headers = (await get("/")).headers;
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  test("interpolated markup is escaped, raw() is not", async () => {
    const html = await getHTML("/about");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<em>Bun-native</em>");
  });

  test("no inline executable script is ever emitted", async () => {
    const html = await getHTML("/");
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)];

    // The only inline <script> permitted is the non-executable JSON payload.
    for (const [, attributes] of inline) {
      expect(attributes).toContain('type="application/json"');
    }
  });

  test("the hydration payload cannot break out of its element", async () => {
    const html = await getHTML("/");
    const payload = html.match(
      /<script type="application\/json" id="kiln-islands">(.*?)<\/script>/s,
    )![1]!;
    expect(payload).not.toContain("<");
    expect(payload).not.toContain(">");
  });
});
