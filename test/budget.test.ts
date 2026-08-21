/**
 * Payload budgets.
 *
 * The README publishes concrete byte counts for the client runtime. Those are
 * the most checkable claims the project makes, so they are checked here: if the
 * runtime grows past its budget this fails, and the documented numbers get
 * corrected rather than quietly becoming false.
 *
 * Budgets are ceilings with headroom, not exact sizes — this should catch a
 * regression, not fail on every refactor.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { buildIslands } from "../src/build/build.ts";
import { discoverIslands } from "../src/build/islands.ts";

const FIXTURE_ROOT = join(import.meta.dir, "fixture");
const OUT_DIR = join(import.meta.dir, "..", ".stoneware-budget");

/** Gzipped ceilings in bytes. Documented figures must stay under these. */
const BUDGET = {
  /** Signals + hydrate + DOM builder, shared by every island page. */
  sharedRuntime: 4096,
  /** The counter island's own entry chunk. */
  smallestIsland: 512,
  /**
   * Everything a page of purely lazy islands downloads before the reader
   * interacts: the runtime entry plus the scheduler chunk it pulls.
   *
   * This is the number the feature exists to keep small. If the scheduler ever
   * imports the DOM builder or signals again - which it did once, through
   * `mountTree` - this budget is what catches it, because the shared runtime
   * would come along and roughly quadruple the figure.
   */
  lazyRuntime: 1536,
};

let chunks: { name: string; gzip: number }[] = [];
let builtDir = "";

/**
 * Gzipped size of a chunk plus everything it imports, transitively.
 *
 * Gzipping each file separately overstates the total slightly, since a real
 * server compresses each response on its own anyway - which is exactly what a
 * browser downloads.
 */
async function transitiveSize(entry: string): Promise<number> {
  const seen = new Set<string>();
  const queue = [entry];
  let total = 0;

  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);

    const chunk = chunks.find((candidate) => candidate.name === name);
    if (!chunk) throw new Error(`Chunk ${name} was imported but not emitted`);
    total += chunk.gzip;

    const source = await Bun.file(join(builtDir, name)).text();
    for (const match of source.matchAll(/from"\.\/([^"]+)"/g)) queue.push(match[1]!);
  }

  return total;
}

beforeAll(async () => {
  const islands = await discoverIslands(join(FIXTURE_ROOT, "islands"));
  const { staticDir } = await buildIslands({ islands, outDir: OUT_DIR, dev: false });
  builtDir = staticDir;

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
    const counter = chunks.find((chunk) => chunk.name.startsWith("Counter-"));
    expect(counter).toBeDefined();
    expect(counter!.gzip).toBeLessThanOrEqual(BUDGET.smallestIsland);
  });

  test("islands are split rather than duplicated into one bundle", () => {
    // Both fixture islands and the lazy runtime, plus at least one shared
    // chunk. If splitting regressed the shared runtime would be inlined into
    // each entry, and the chunk count would collapse to the entry count.
    const entries = chunks.filter((chunk) => !chunk.name.startsWith("chunk-"));
    expect(entries.length).toBe(3);
    expect(chunks.length).toBeGreaterThan(entries.length);
  });

  test("a page of only lazy islands downloads almost nothing up front", async () => {
    // Follow the runtime entry's imports rather than guessing which chunk it
    // uses: the assertion has to fail if the graph changes, not just the sizes.
    const entry = chunks.find((chunk) => chunk.name.startsWith("stoneware-runtime-"));
    expect(entry).toBeDefined();

    const total = await transitiveSize(entry!.name);
    expect(total).toBeLessThanOrEqual(BUDGET.lazyRuntime);
  });

  test("the framework keeps exactly one runtime dependency", async () => {
    const pkg = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
    expect(Object.keys(pkg.dependencies)).toEqual(["@preact/signals-core"]);
  });
});
