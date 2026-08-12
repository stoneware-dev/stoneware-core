/**
 * Payload budgets.
 *
 * The README and the "What it solves" page publish concrete byte counts. Those
 * are the most checkable claims the project makes, so they are checked here: if
 * the client runtime grows past its budget, this fails and the documented
 * numbers get corrected rather than quietly becoming false.
 *
 * Budgets are ceilings with headroom, not exact sizes — this should catch a
 * regression, not fail on every refactor.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { buildIslands } from "../src/build.ts";
import { discoverIslands } from "../src/islands.ts";

const SITE_ROOT = join(import.meta.dir, "..", "example");
const OUT_DIR = join(import.meta.dir, "..", ".stoneware-budget");

/** Gzipped ceilings in bytes. Documented figures must stay under these. */
const BUDGET = {
  /** Signals + hydrate + DOM builder, shared by every island page. */
  sharedRuntime: 4096,
  /** The counter island's own entry chunk. */
  smallestIsland: 512,
};

let chunks: { name: string; gzip: number }[] = [];

beforeAll(async () => {
  const islands = await discoverIslands(join(SITE_ROOT, "islands"));
  const { staticDir } = await buildIslands({ islands, outDir: OUT_DIR, dev: false });

  const glob = new Bun.Glob("*.js");
  chunks = [];
  for await (const file of glob.scan({ cwd: staticDir, absolute: true })) {
    const bytes = await Bun.file(file).bytes();
    chunks.push({ name: basename(file), gzip: Bun.gzipSync(bytes).length });
  }
});

afterAll(async () => {
  await rm(OUT_DIR, { recursive: true, force: true });
});

describe("client payload", () => {
  test("the shared runtime chunk stays within budget", () => {
    const shared = chunks.filter((chunk) => chunk.name.startsWith("chunk-"));
    expect(shared.length).toBeGreaterThan(0);

    const largest = Math.max(...shared.map((chunk) => chunk.gzip));
    expect(largest).toBeLessThanOrEqual(BUDGET.sharedRuntime);
  });

  test("a trivial island's own chunk stays tiny", () => {
    const counter = chunks.find((chunk) => chunk.name.startsWith("LiveCounter-"));
    expect(counter).toBeDefined();
    expect(counter!.gzip).toBeLessThanOrEqual(BUDGET.smallestIsland);
  });

  test("islands are split rather than duplicated into one bundle", () => {
    // Four islands plus at least one shared chunk. If splitting regressed, the
    // shared runtime would be inlined into each entry and this count would drop.
    const entries = chunks.filter((chunk) => !chunk.name.startsWith("chunk-"));
    expect(entries.length).toBe(4);
    expect(chunks.length).toBeGreaterThan(entries.length);
  });

  test("the framework keeps exactly one runtime dependency", async () => {
    const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    expect(Object.keys(pkg.dependencies)).toEqual(["@preact/signals-core"]);
  });
});
