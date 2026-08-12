/**
 * Integration tests: request in, expected HTML out (CLAUDE.md §15).
 *
 * One block per v0.1 milestone, run against test/fixture. The fixture exists so
 * these assertions describe framework behavior only - editing documentation
 * copy in example/ can never break them. A separate smoke block checks that the
 * docs site itself still builds and serves.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/server.ts";
import type { StonewareApp } from "../src/server.ts";

const FIXTURE_ROOT = join(import.meta.dir, "fixture");
const SECRET = "integration-test-secret-0123456789";

let app: StonewareApp;

beforeAll(async () => {
  app = await createApp({ root: FIXTURE_ROOT, csrf: { secret: SECRET } }, { dev: true });
});

const get = (path: string) => app.fetch(new Request(`http://localhost${path}`));

async function getHTML(path: string): Promise<string> {
  return await (await get(path)).text();
}

/** Pull a live CSRF token out of the rendered homepage. */
async function freshToken(): Promise<string> {
  const html = await getHTML("/");
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error("Fixture homepage did not render a CSRF token");
  return match[1]!;
}

describe("milestone 1 - static SSR", () => {
  test("renders a complete HTML document", async () => {
    const response = await get("/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");

    const html = await response.text();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<title>Fixture home</title>");
    expect(html).toContain("</html>");
  });

  test("renders dynamic route params", async () => {
    expect(await getHTML("/blog/hello-world")).toContain("<h1>Entry: hello-world</h1>");
  });

  test("escapes params rather than interpolating them raw", async () => {
    const html = await getHTML("/blog/%3Cscript%3E");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  test("unmatched paths 404", async () => {
    expect((await get("/no/such/page")).status).toBe(404);
  });

  test("serves files from public/ as-is", async () => {
    const response = await get("/styles.css");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("rebeccapurple");
  });

  test("refuses path traversal out of the asset directories", async () => {
    expect((await get("/_stoneware/..%2f..%2fpackage.json")).status).toBe(404);
  });
});

describe("milestone 2 - islands", () => {
  test("islands are server-rendered with real content, not placeholders", async () => {
    const html = await getHTML("/");
    expect(html).toContain('data-stoneware-island="Counter"');
    expect(html).toContain("Clicked 0 times");
    expect(html).toContain("<strong>7</strong> total");
  });

  test("each island on the page gets exactly one module script", async () => {
    const html = await getHTML("/");
    const sources = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map(
      (match) => match[1]!,
    );

    expect(sources).toHaveLength(2);
    expect(new Set(sources).size).toBe(2);
    for (const source of sources) expect(source.startsWith("/_stoneware/")).toBe(true);
  });

  test("built island chunks are served", async () => {
    const response = await get(app.islandManifest.Counter!);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("hydrate");
  });

  test("a page with no islands ships no JavaScript at all", async () => {
    const html = await getHTML("/plain");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("/_stoneware/");
  });
});

describe("milestone 3 - signals", () => {
  test("island props reach the client as escaped JSON", async () => {
    const html = await getHTML("/");
    const payload = html.match(
      /<script type="application\/json" id="stoneware-islands">(.*?)<\/script>/s,
    )?.[1];

    expect(payload).toBeDefined();
    const parsed = JSON.parse(payload!) as { name: string; id: string; props: object }[];
    expect(parsed.map((entry) => entry.name)).toEqual(["Badge", "Counter"]);
    expect(parsed.every((entry) => typeof entry.id === "string")).toBe(true);
  });

  test("a shared signal is bundled once, into a chunk both islands import", async () => {
    const counter = await (await get(app.islandManifest.Counter!)).text();
    const badge = await (await get(app.islandManifest.Badge!)).text();

    const chunkOf = (source: string): string[] =>
      source.match(/from\s*"\.\/(chunk-[^"]+\.js)"/g) ?? [];
    const shared = chunkOf(counter).filter((chunk) => chunkOf(badge).includes(chunk));

    expect(shared.length).toBeGreaterThan(0);
  });
});

describe("milestone 4 - server actions and CSRF", () => {
  async function post(fields: Record<string, string>, headers: Record<string, string> = {}) {
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.append(key, value);
    return app.fetch(
      new Request("http://localhost/api/echo", {
        method: "POST",
        body,
        headers: { Accept: "application/json", ...headers },
      }),
    );
  }

  test("<Form> injects a hidden CSRF field with no configuration", async () => {
    expect(await getHTML("/")).toMatch(/<input type="hidden" name="_csrf" value="[^"]+">/);
  });

  test("a valid token reaches the handler with an unconsumed body", async () => {
    const response = await post({ message: "hello", _csrf: await freshToken() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, message: "hello" });
  });

  test("a missing token is rejected before the handler runs", async () => {
    expect((await post({ message: "x" })).status).toBe(403);
  });

  test("a forged token is rejected", async () => {
    expect((await post({ message: "x", _csrf: "forged" })).status).toBe(403);
  });

  test("islands can send the token as a header instead", async () => {
    const response = await post({ message: "hi" }, { "x-csrf-token": await freshToken() });
    expect(response.status).toBe(200);
  });

  test("an action rejects methods it does not export", async () => {
    const response = await get("/api/echo");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  test("a page route rejects POST", async () => {
    const body = new FormData();
    body.append("_csrf", await freshToken());
    const response = await app.fetch(
      new Request("http://localhost/plain", { method: "POST", body }),
    );
    expect(response.status).toBe(405);
  });
});

describe("milestone 5 - security defaults", () => {
  test("every HTML response carries a CSP with no unsafe directives", async () => {
    for (const path of ["/", "/plain", "/blog/x", "/no/such/page"]) {
      const csp = (await get(path)).headers.get("content-security-policy");
      expect(csp).toBeTruthy();
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
    }
  });

  test("server action responses are covered too", async () => {
    const response = await get("/api/echo"); // 405, still a response
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
    const html = await getHTML("/plain");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("<em>trusted</em>");
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
      /<script type="application\/json" id="stoneware-islands">(.*?)<\/script>/s,
    )![1]!;
    expect(payload).not.toContain("<");
    expect(payload).not.toContain(">");
  });

  test("no inline style attribute is emitted, which the default CSP would block", async () => {
    for (const path of ["/", "/plain"]) {
      expect(await getHTML(path)).not.toMatch(/<[^>]+\sstyle="/);
    }
  });
});
