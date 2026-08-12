/**
 * Build pipeline (CLAUDE.md §11).
 *
 * Islands are bundled one entry point at a time so a page downloads only the
 * islands it actually uses. Code splitting is on, so the client runtime and
 * signals are hoisted into a shared chunk instead of being duplicated into every
 * island bundle.
 *
 * Nothing under `routes/` is ever an entry point here. That is the mechanism
 * behind "no client JS unless a component is explicitly an island" - server-only
 * code is not excluded by a heuristic, it is simply never handed to the bundler.
 */

import { mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { IslandEntry } from "./islands.ts";

/** URL prefix under which built client chunks are served. */
export const CLIENT_ASSET_PREFIX = "/_stoneware";

/** Filename of the island manifest left in `outDir` by a build. */
export const ISLAND_MANIFEST_FILE = "islands.json";

/** Maps island name to the public URL of its entry chunk. */
export type IslandManifest = Record<string, string>;

export interface BuildIslandsOptions {
  islands: IslandEntry[];
  /** Build output root, typically `<project>/.stoneware`. */
  outDir: string;
  dev?: boolean;
}

export interface BuildIslandsResult {
  manifest: IslandManifest;
  /** Directory holding the emitted client chunks. */
  staticDir: string;
  outputs: string[];
}

/**
 * Generate the entry module that boots one island in the browser.
 *
 * Written to disk rather than passed as a virtual module because `Bun.build`
 * resolves entry points from the filesystem, and a real file also keeps
 * sourcemaps pointing somewhere meaningful.
 */
function entrySource(island: IslandEntry): string {
  // Forward slashes keep the generated import valid on Windows, where a raw
  // path would otherwise contain backslash escape sequences.
  const importPath = island.path.replace(/\\/g, "/");
  return [
    `import { hydrate } from ${JSON.stringify("stoneware/client")};`,
    `import Island from ${JSON.stringify(importPath)};`,
    ``,
    `hydrate(${JSON.stringify(island.name)}, Island);`,
    ``,
  ].join("\n");
}

export async function buildIslands(options: BuildIslandsOptions): Promise<BuildIslandsResult> {
  const outDir = resolve(options.outDir);
  const entriesDir = join(outDir, "entries");
  const staticDir = join(outDir, "static");

  await rm(entriesDir, { recursive: true, force: true });
  await rm(staticDir, { recursive: true, force: true });
  await mkdir(entriesDir, { recursive: true });

  if (options.islands.length === 0) {
    await mkdir(staticDir, { recursive: true });
    await Bun.write(join(outDir, ISLAND_MANIFEST_FILE), "{}");
    return { manifest: {}, staticDir, outputs: [] };
  }

  const entrypoints: string[] = [];
  const entryToIsland = new Map<string, IslandEntry>();

  for (const island of options.islands) {
    const entryPath = join(entriesDir, `${island.chunkName}.ts`);
    await Bun.write(entryPath, entrySource(island));
    entrypoints.push(entryPath);
    entryToIsland.set(island.chunkName, island);
  }

  const result = await Bun.build({
    entrypoints,
    outdir: staticDir,
    target: "browser",
    format: "esm",
    splitting: true,
    minify: !options.dev,
    sourcemap: options.dev ? "linked" : "none",
    naming: {
      entry: "[name]-[hash].js",
      chunk: "chunk-[hash].js",
      asset: "[name]-[hash].[ext]",
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify(options.dev ? "development" : "production"),
    },
  });

  if (!result.success) {
    const details = result.logs.map((log) => String(log)).join("\n");
    throw new Error(`Island build failed:\n${details}`);
  }

  const manifest: IslandManifest = {};
  const outputs: string[] = [];

  for (const artifact of result.outputs) {
    const file = basename(artifact.path);
    outputs.push(file);
    if (artifact.kind !== "entry-point") continue;

    // `[name]-[hash].js` - recover the entry name by stripping the hash suffix.
    const chunkName = file.replace(/-[^-]+\.js$/, "");
    const island = entryToIsland.get(chunkName);
    if (island) manifest[island.name] = `${CLIENT_ASSET_PREFIX}/${file}`;
  }

  const missing = options.islands.filter((island) => !(island.name in manifest));
  if (missing.length > 0) {
    throw new Error(
      `Island build produced no entry chunk for: ${missing.map((i) => i.name).join(", ")}`,
    );
  }

  // Persisted so a production server can serve pre-built, content-hashed chunks
  // instead of rebuilding them (and changing their filenames) on every boot.
  await Bun.write(join(outDir, ISLAND_MANIFEST_FILE), JSON.stringify(manifest, null, 2));

  return { manifest, staticDir, outputs };
}
