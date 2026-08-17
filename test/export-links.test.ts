/**
 * An export that ships links to pages it never wrote.
 *
 * The export already reports which routes it skipped, and that line is easy to
 * read past: one line among several, informational in tone, and the command
 * exits 0. So a site deploys whose own navigation points at pages that were
 * never written, every one of them 404s, and the first anyone hears of it is a
 * visitor — on a deploy that otherwise looks finished.
 *
 * This happened on a real site: seven division pages, all linked from an
 * exported index, none of them written, because the dynamic route had no
 * `staticPaths()`. The export said so and still exited 0.
 *
 * What is asserted here is therefore not "does it find a broken link" but the
 * two properties that decide whether anyone can trust the report: it must find
 * the ones that will really 404, and it must stay quiet about the ones that
 * will not.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportSite } from "../src/cli/export.ts";
import type { ExportResult } from "../src/cli/export.ts";

const FIXTURE = join(import.meta.dir, "fixture-dangling");
const OUT = join(tmpdir(), `stoneware-links-${Date.now()}`);

let result: ExportResult;

beforeAll(async () => {
  process.env.STONEWARE_CSRF_SECRET = "export-links-secret-0123456789";
  result = await exportSite(FIXTURE, OUT);
});

afterAll(async () => {
  await rm(OUT, { recursive: true, force: true });
  await rm(join(FIXTURE, ".stoneware"), { recursive: true, force: true });
});

/** Every dangling target, as a plain list. */
const targets = () => result.dangling.map((link) => link.to);

describe("what it reports", () => {
  test("a dynamic route with no staticPaths, once per linked URL", () => {
    // The failure that motivated this. The route was skipped, the links to it
    // were written anyway, and both of these 404 on the deployed site.
    expect(targets()).toContain("/items/first");
    expect(targets()).toContain("/items/second");
  });

  test("a link to a route that does not exist at all", () => {
    // A typo in an href is the same failure with a different cause, and the
    // export is the only place it can be caught before a visitor finds it.
    expect(targets()).toContain("/nowhere");
  });

  test("a missing asset, not only a missing page", () => {
    // A stylesheet or island chunk that is not there presents as "the CSS is
    // broken" rather than as a missing file, which is why src is checked too.
    expect(targets()).toContain("/missing.png");
  });

  test("it says which page the link is on", () => {
    // A list of broken URLs with no source is a list nobody can act on.
    for (const link of result.dangling) expect(link.from).toBe("/");
  });
});

describe("what it stays quiet about", () => {
  // A check that cries wolf is a check people pass --no-verify to.

  test("a page that was exported", () => {
    expect(targets()).not.toContain("/about");
  });

  test("the same page with a query and a fragment", () => {
    // A static host serves the same file either way.
    expect(targets()).not.toContain("/about?ref=nav#top");
    expect(targets().some((t) => t.includes("?"))).toBe(false);
    expect(targets().some((t) => t.includes("#"))).toBe(false);
  });

  test("an external origin", () => {
    expect(targets().some((t) => t.startsWith("http"))).toBe(false);
  });

  test("a bare fragment", () => {
    expect(targets()).not.toContain("#section");
  });

  test("a file that came from public/", () => {
    expect(targets()).not.toContain("/logo.svg");
  });

  test("the framework's own stylesheet and island chunks", () => {
    // These are copied into the export after the pages are written, so a check
    // that ran too early would report every one of them.
    expect(targets().some((t) => t.startsWith("/_stoneware/"))).toBe(false);
  });

  test("nothing else at all", () => {
    // The exact set, so a future change that starts reporting something extra
    // fails here rather than in someone's CI.
    expect([...targets()].sort()).toEqual([
      "/items/first",
      "/items/second",
      "/missing.png",
      "/nowhere",
    ]);
  });
});

describe("the skipped list still says why", () => {
  test("the route that produced the dangling links is named", () => {
    expect(result.skipped.join(" ")).toContain("/items/[id] (no staticPaths export)");
  });

  test("the pages that could be written still were", () => {
    // A site with one broken section still exports the rest: the report is a
    // warning about the output, not a refusal to produce it.
    expect(result.pages).toBe(2);
  });
});
