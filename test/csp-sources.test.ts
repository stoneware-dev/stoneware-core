/**
 * Extending the Content-Security-Policy for a third party.
 *
 * The framework's default policy is restrictive on purpose, and before this
 * existed the only way to allow one origin was to retype the whole policy as a
 * string. That is the failure this feature is about: a policy retyped by hand
 * is a policy with `object-src 'none'` or `base-uri 'self'` missing from it,
 * and nothing anywhere reports the omission.
 *
 * So the tests worth having are not "does googletagmanager.com appear". They
 * are: does everything I did *not* mention survive, and can a value smuggle in
 * a directive of its own.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CSP, buildCSP, resolveConfig } from "../src/config.ts";
import { createApp } from "../src/http/server.ts";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixture");
const SECRET = "csp-sources-secret-0123456789";

/** The policy as a directive -> sources map, for assertions that read clearly. */
function parse(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const directive of policy.split("; ")) {
    const [name, ...values] = directive.split(" ");
    out[name!] = values;
  }
  return out;
}

describe("what the default policy sends", () => {
  test("no config means the documented default, unchanged", () => {
    process.env.STONEWARE_CSRF_SECRET = SECRET;
    expect(resolveConfig({ root: FIXTURE }).csp).toBe(DEFAULT_CSP);
  });

  test("the default allows no third party anywhere", () => {
    const policy = parse(DEFAULT_CSP);
    for (const [name, values] of Object.entries(policy)) {
      for (const value of values) {
        // 'self', 'none' and data: only. Anything with a host would mean the
        // framework had quietly allowed someone by default.
        expect(value).toMatch(/^('self'|'none'|data:)$/);
      }
    }
  });

  test("no unsafe-inline or unsafe-eval anywhere in it", () => {
    expect(DEFAULT_CSP).not.toContain("unsafe-inline");
    expect(DEFAULT_CSP).not.toContain("unsafe-eval");
  });
});

describe("the object form adds without removing", () => {
  const extended = parse(
    buildCSP({
      scriptSrc: ["https://www.googletagmanager.com"],
      connectSrc: ["https://www.google-analytics.com"],
      imgSrc: ["https://www.google-analytics.com"],
    }),
  );

  test("'self' survives on every directive it touched", () => {
    expect(extended["script-src"]).toContain("'self'");
    expect(extended["connect-src"]).toContain("'self'");
    expect(extended["img-src"]).toContain("'self'");
  });

  test("the named origins are allowed", () => {
    expect(extended["script-src"]).toContain("https://www.googletagmanager.com");
    expect(extended["connect-src"]).toContain("https://www.google-analytics.com");
    expect(extended["img-src"]).toContain("https://www.google-analytics.com");
  });

  test("existing values on a touched directive are kept", () => {
    // img-src carries `data:` by default, and adding an origin must not drop
    // it - inline SVG and canvas exports would stop rendering.
    expect(extended["img-src"]).toContain("data:");
  });

  test("directives never mentioned are byte-identical to the default", () => {
    const base = parse(DEFAULT_CSP);
    for (const name of ["object-src", "base-uri", "form-action", "frame-ancestors", "style-src", "font-src"]) {
      expect(extended[name]).toEqual(base[name]);
    }
  });

  test("the whole policy is still one header value", () => {
    expect(buildCSP({ scriptSrc: ["https://x.example"] })).not.toContain("\n");
  });
});

describe("directives the default policy does not list", () => {
  test("are seeded with 'self' rather than replacing the default-src fallback", () => {
    // frame-src and worker-src inherit from default-src 'self'. Creating them
    // with only the third party would allow theirs and block the site's own.
    const policy = parse(
      buildCSP({ frameSrc: ["https://js.stripe.com"], workerSrc: ["blob:"] }),
    );

    expect(policy["frame-src"]).toEqual(["'self'", "https://js.stripe.com"]);
    expect(policy["worker-src"]).toEqual(["'self'", "blob:"]);
  });

  test("'none' is replaced, not appended to", () => {
    // A browser treats `object-src 'none' https://x` as invalid, which would
    // silently widen the directive rather than narrow it.
    const policy = parse(buildCSP({ objectSrc: ["https://cdn.example"] }));
    expect(policy["object-src"]).toEqual(["https://cdn.example"]);
    expect(policy["object-src"]).not.toContain("'none'");
  });

  test("a repeated source is listed once", () => {
    const policy = parse(buildCSP({ scriptSrc: ["'self'", "https://a.example", "https://a.example"] }));
    expect(policy["script-src"]).toEqual(["'self'", "https://a.example"]);
  });
});

describe("a source cannot smuggle in a directive", () => {
  // These values routinely come from an environment variable or a CMS field,
  // so a source that ends the directive and starts another is a real path to
  // re-enabling exactly what the default policy forbids.
  test("a semicolon is refused", () => {
    expect(() => buildCSP({ scriptSrc: ["https://x.example; script-src 'unsafe-inline'"] })).toThrow(
      /one token/,
    );
  });

  test("a comma is refused", () => {
    expect(() => buildCSP({ scriptSrc: ["https://a.example,https://b.example"] })).toThrow(/one token/);
  });

  test("whitespace is refused, because it is two sources pretending to be one", () => {
    expect(() => buildCSP({ scriptSrc: ["https://a.example https://b.example"] })).toThrow(/one token/);
  });

  test("an empty source is refused", () => {
    expect(() => buildCSP({ scriptSrc: [""] })).toThrow(/empty source/);
  });

  test("the directive is named in the error", () => {
    expect(() => buildCSP({ connectSrc: ["bad;value"] })).toThrow(/csp\.connectSrc/);
  });
});

describe("the other two forms still behave", () => {
  test("a string replaces the policy entirely", () => {
    process.env.STONEWARE_CSRF_SECRET = SECRET;
    const custom = "default-src 'self'; script-src 'self' https://only.example";
    expect(resolveConfig({ root: FIXTURE, csp: custom }).csp).toBe(custom);
  });

  test("false still removes the header", () => {
    process.env.STONEWARE_CSRF_SECRET = SECRET;
    expect(resolveConfig({ root: FIXTURE, csp: false }).csp).toBe(false);
  });
});

describe("the extended policy reaches a real response", () => {
  test("as the Content-Security-Policy header", async () => {
    const app = await createApp(
      {
        root: FIXTURE,
        csrf: { secret: SECRET },
        csp: { scriptSrc: ["https://www.googletagmanager.com"] },
      },
      { dev: true },
    );

    const header = (await app.fetch(new Request("http://localhost/plain"))).headers.get(
      "Content-Security-Policy",
    );

    expect(header).toContain("script-src 'self' https://www.googletagmanager.com");
    // And the rest of the policy is still on the wire, not just in the object.
    expect(header).toContain("object-src 'none'");
    expect(header).toContain("frame-ancestors 'none'");
  });

  test("islands are still served under it", async () => {
    // The island chunks come from 'self', so extending script-src for a third
    // party must not disturb the framework's own scripts.
    const app = await createApp(
      { root: FIXTURE, csrf: { secret: SECRET }, csp: { scriptSrc: ["https://x.example"] } },
      { dev: true },
    );

    const html = await (await app.fetch(new Request("http://localhost/"))).text();
    expect(html).toMatch(/<script type="module" src="\/_stoneware\/[^"]+\.js">/);
    expect(html).not.toContain("unsafe-inline");
  });
});
