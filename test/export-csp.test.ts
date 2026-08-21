/**
 * A static export used to ship with no Content-Security-Policy at all.
 *
 * The framework's claim is that the policy is never silently absent, and it held
 * for `stoneware start` - where the CSP is a response header - while quietly
 * failing for `stoneware export`, because a directory of files carries no
 * headers. Nothing errored; the pages simply had no policy, and the loss was
 * invisible unless you thought to check response headers on a host you had not
 * configured.
 *
 * Two mechanisms now cover it, because neither is sufficient alone:
 *
 *   `_headers`  the real thing, on hosts that read it (Netlify, Cloudflare
 *               Pages). Carries every directive, including frame-ancestors.
 *   `<meta>`    everywhere else, including GitHub Pages. Cannot carry
 *               frame-ancestors, report-uri or sandbox - browsers ignore those
 *               in a meta tag - so they are stripped rather than implied.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { exportSite } from "../src/cli/export.ts";
import { metaCSP } from "../src/render/document.ts";
import { DEFAULT_CSP } from "../src/config.ts";
import type { ExportResult } from "../src/cli/export.ts";

const FIXTURE = join(import.meta.dir, "fixture");
const ROOT = join(import.meta.dir, "..", ".export-csp-test");
const OUT = join(ROOT, "dist");

let result: ExportResult;
let page = "";
let headers = "";

beforeAll(async () => {
  process.env.STONEWARE_CSRF_SECRET = "export-csp-secret-0123456789";
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  await cp(FIXTURE, ROOT, { recursive: true });
  await rm(join(ROOT, ".stoneware"), { recursive: true, force: true });

  result = await exportSite(ROOT, OUT);
  page = await Bun.file(join(OUT, "plain", "index.html")).text();
  headers = await Bun.file(join(OUT, "_headers")).text();
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("the embedded meta policy", () => {
  test("every exported page carries one", () => {
    expect(page).toContain('<meta http-equiv="Content-Security-Policy"');
  });

  test("it holds the directives that actually work in a meta tag", () => {
    expect(page).toContain("script-src &#x27;self&#x27;");
    expect(page).toContain("object-src &#x27;none&#x27;");
  });

  test("frame-ancestors is left out rather than implied", () => {
    // Browsers ignore it in a meta tag. Emitting it would advertise clickjacking
    // protection the page does not have.
    expect(page).not.toContain("frame-ancestors");
  });

  test("it comes before anything it is meant to govern", () => {
    // A meta policy only applies to resources declared after it, so a stylesheet
    // or preload placed above it would escape the policy entirely.
    const csp = page.indexOf("Content-Security-Policy");
    const firstLink = page.indexOf("<link");
    const firstScript = page.indexOf("<script");

    expect(csp).toBeGreaterThan(-1);
    if (firstLink !== -1) expect(csp).toBeLessThan(firstLink);
    if (firstScript !== -1) expect(csp).toBeLessThan(firstScript);
  });

  test("charset still comes first", () => {
    // It has to land within the first 1024 bytes, and a parser that has not seen
    // it yet is guessing at the bytes that follow.
    expect(page.indexOf("charset")).toBeLessThan(page.indexOf("Content-Security-Policy"));
  });
});

describe("_headers", () => {
  test("is written for hosts that read one", () => {
    expect(headers).toStartWith("/*");
  });

  test("carries the full policy, frame-ancestors included", () => {
    // This is the half the meta tag cannot do, which is the reason both exist.
    expect(headers).toContain("Content-Security-Policy:");
    expect(headers).toContain("frame-ancestors 'none'");
  });

  test("carries the other security headers too", () => {
    expect(headers).toContain("X-Content-Type-Options: nosniff");
    expect(headers).toContain("X-Frame-Options: DENY");
    expect(headers).toContain("Referrer-Policy: strict-origin-when-cross-origin");
  });
});

describe("what the export reports", () => {
  test("it names the directives a header-less host loses", () => {
    // Reporting parity that does not exist would be worse than reporting
    // nothing: someone would deploy to GitHub Pages believing they had it.
    expect(result.headerOnly).toContain("frame-ancestors 'none'");
  });

  test("it reports the policy it used", () => {
    expect(result.csp).toBe(DEFAULT_CSP);
  });
});

describe("metaCSP", () => {
  test("drops every directive a meta tag cannot express", () => {
    const policy = metaCSP(
      "default-src 'self'; frame-ancestors 'none'; report-uri /r; sandbox allow-forms",
    );
    expect(policy).toContain("default-src");
    expect(policy).not.toContain("frame-ancestors");
    expect(policy).not.toContain("report-uri");
    expect(policy).not.toContain("sandbox");
  });

  test("does not strip a directive that merely starts with the same letters", () => {
    const policy = metaCSP("default-src 'self'; frame-src 'none'");
    expect(policy).toContain("frame-src");
  });

  test("returns nothing when every directive was header-only", () => {
    // An empty meta tag would be noise in the markup and protection in nobody's
    // browser.
    expect(metaCSP("frame-ancestors 'none'")).toBe("");
  });

  test("escapes the content attribute", () => {
    expect(metaCSP(`default-src 'self'`)).toContain("&#x27;self&#x27;");
  });
});
