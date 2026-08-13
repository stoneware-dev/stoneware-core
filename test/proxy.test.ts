/**
 * Bug 1: the public URL behind a TLS-terminating proxy.
 *
 * Render, Railway, Fly and nginx forward a plain HTTP request, so `request.url`
 * reports `http://` for a site served over `https://`. Everything absolute a
 * page builds comes from that URL, so getting it wrong put
 * `<link rel="canonical" href="http://...">` on every page of a live HTTPS site.
 */

import { describe, expect, test } from "bun:test";
import { requestURL } from "../src/url.ts";
import { resolveConfig } from "../src/config.ts";

const forwarded = (headers: Record<string, string>) =>
  new Request("http://internal:3000/docs/seo", { headers });

describe("trustProxy: false (the default)", () => {
  test("forwarded headers are ignored", () => {
    const url = requestURL(forwarded({ "x-forwarded-proto": "https" }), false);
    expect(url.protocol).toBe("http:");
  });

  test("a project gets it off unless it asks", () => {
    // These headers are forgeable by anyone who can reach the app directly, so
    // honouring them is a decision rather than a default.
    const config = resolveConfig({ csrf: { secret: "proxy-test-secret-0123456789" } }, true);
    expect(config.trustProxy).toBe(false);
  });
});

describe('trustProxy: "proto"', () => {
  test("the scheme is taken from X-Forwarded-Proto", () => {
    const url = requestURL(forwarded({ "x-forwarded-proto": "https" }), "proto");
    expect(url.origin).toBe("https://internal:3000");
  });

  test("the host is not, even when forwarded", () => {
    // A forged X-Forwarded-Host poisons every absolute URL the app emits, so it
    // needs the stronger opt-in.
    const url = requestURL(
      forwarded({ "x-forwarded-proto": "https", "x-forwarded-host": "evil.test" }),
      "proto",
    );
    expect(url.host).toBe("internal:3000");
  });

  test("a nonsense scheme is ignored rather than assigned", () => {
    const url = requestURL(forwarded({ "x-forwarded-proto": "javascript" }), "proto");
    expect(url.protocol).toBe("http:");
  });
});

describe("trustProxy: true", () => {
  test("both scheme and host are taken from the headers", () => {
    const url = requestURL(
      forwarded({ "x-forwarded-proto": "https", "x-forwarded-host": "stoneware.example" }),
      true,
    );
    expect(url.origin).toBe("https://stoneware.example");
  });

  test("only the first entry of a proxy chain is used", () => {
    // Each hop appends its own value; the first is what the client spoke.
    const url = requestURL(forwarded({ "x-forwarded-proto": "https, http" }), true);
    expect(url.protocol).toBe("https:");
  });

  test("a host that could not have come from a real request is ignored", () => {
    for (const host of ["evil.test/path", "http://evil.test", "evil test", ""]) {
      const url = requestURL(forwarded({ "x-forwarded-host": host }), true);
      expect(url.host).toBe("internal:3000");
    }
  });

  test("a port in the forwarded host is kept", () => {
    const url = requestURL(forwarded({ "x-forwarded-host": "example.test:8443" }), true);
    expect(url.host).toBe("example.test:8443");
  });
});

describe("configuration", () => {
  test("the env var turns it on without a code change", () => {
    // Whether a proxy is in front is a property of the deployment, not of the
    // project, so a deploy can set it without editing source.
    const secret = { csrf: { secret: "proxy-test-secret-0123456789" } };

    process.env.STONEWARE_TRUST_PROXY = "1";
    expect(resolveConfig(secret, true).trustProxy).toBe(true);

    process.env.STONEWARE_TRUST_PROXY = "proto";
    expect(resolveConfig(secret, true).trustProxy).toBe("proto");

    delete process.env.STONEWARE_TRUST_PROXY;
    expect(resolveConfig(secret, true).trustProxy).toBe(false);
  });

  test("the config file wins over the environment", () => {
    process.env.STONEWARE_TRUST_PROXY = "1";
    const config = resolveConfig(
      { csrf: { secret: "proxy-test-secret-0123456789" }, trustProxy: false },
      true,
    );
    expect(config.trustProxy).toBe(false);
    delete process.env.STONEWARE_TRUST_PROXY;
  });
});
