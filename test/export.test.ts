/**
 * Static export: `stoneware export` prerenders the site to plain files.
 *
 * Kept in its own file because export writes to disk. The output directory is a
 * temp path rather than test/fixture/dist, so a failed run cannot leave stray
 * files inside the fixture the other suites read from.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportSite } from "../src/cli/export.ts";
import type { ExportResult } from "../src/cli/export.ts";

const FIXTURE_ROOT = join(import.meta.dir, "fixture");
const OUT_DIR = join(tmpdir(), `stoneware-export-${Date.now()}`);

let result: ExportResult;

beforeAll(async () => {
  // A production build refuses to start without a secret, and export builds one.
  process.env.STONEWARE_CSRF_SECRET = "export-test-secret-0123456789abcd";
  result = await exportSite(FIXTURE_ROOT, OUT_DIR);
});

afterAll(async () => {
  await rm(OUT_DIR, { recursive: true, force: true });
});

describe("static export", () => {
  test("writes a page as <path>/index.html", async () => {
    // Not <path>.html: a static host then serves it at the same URL the dev
    // server used, with no trailing-slash redirect to configure.
    const page = join(OUT_DIR, "plain", "index.html");
    expect(existsSync(page)).toBe(true);

    const html = await Bun.file(page).text();
    expect(html).toStartWith("<!DOCTYPE html>");
  });

  test("output is what the server would have sent", async () => {
    // Export fetches through the ordinary pipeline rather than a second
    // rendering path, so there is nothing that can drift between the two.
    const { createApp } = await import("../src/server.ts");
    const app = await createApp({ root: FIXTURE_ROOT }, { dev: false });
    const served = await (await app.fetch(new Request("http://localhost/plain"))).text();

    const written = await Bun.file(join(OUT_DIR, "plain", "index.html")).text();
    expect(written).toBe(served);
  });

  test("copies island chunks and public/ alongside the pages", () => {
    expect(existsSync(join(OUT_DIR, "_stoneware"))).toBe(true);
    expect(existsSync(join(OUT_DIR, "styles.css"))).toBe(true);
  });

  test("never writes a page that renders a CSRF token", async () => {
    // A prerendered token would be frozen into the file and handed to every
    // visitor, which is no protection at all.
    expect(existsSync(join(OUT_DIR, "index.html"))).toBe(false);
    expect(result.skipped).toContain("/ (renders a CSRF token)");
  });

  test("skips server actions rather than failing on them", () => {
    expect(result.skipped.some((entry) => entry.includes("server action"))).toBe(true);
  });

  test("skips a dynamic route with no staticPaths, and names it", () => {
    // Guessing which pages exist is not possible, so the omission is reported
    // rather than silently producing an incomplete site.
    expect(result.skipped).toContain("/blog/[slug] (no staticPaths export)");
  });

  test("reports the pages it did write", () => {
    expect(result.pages).toBeGreaterThan(0);
    expect(result.outDir).toBe(OUT_DIR);
  });

  test("writes 404.html, which is what a static host looks for", async () => {
    // A 404 has no URL of its own, so it is produced by requesting a path that
    // cannot match rather than by routing to it.
    const page = join(OUT_DIR, "404.html");
    expect(existsSync(page)).toBe(true);
    expect(await Bun.file(page).text()).toContain("404");
  });

  test("does not export a reserved route as a page", () => {
    expect(existsSync(join(OUT_DIR, "_404"))).toBe(false);
    expect(existsSync(join(OUT_DIR, "_500"))).toBe(false);
  });

  test("fails rather than writing a page that errored", async () => {
    // A broken page should stop the build, not ship as a 500 frozen to disk.
    const root = join(import.meta.dir, "fixture-errors");
    const out = join(tmpdir(), `stoneware-export-fail-${Date.now()}`);

    await expect(exportSite(root, out)).rejects.toThrow(/returned 500 during export/);
    await rm(out, { recursive: true, force: true });
  });
});
