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

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { IslandEntry } from "./islands.ts";

/** URL prefix under which built client chunks are served. */
export const CLIENT_ASSET_PREFIX = "/_stoneware";

/** Filename of the island manifest left in `outDir` by a build. */
export const ISLAND_MANIFEST_FILE = "islands.json";

/** Records the hashed stylesheet URL, when the project has any CSS. */
export const STYLESHEET_MANIFEST_FILE = "stylesheet.txt";

/**
 * Collect every stylesheet that sits beside the code it styles.
 *
 * A `.css` file anywhere under routes/, islands/ or lib/ is part of the site's
 * styles. Membership is by location rather than by an `import` statement,
 * because routes and lib are server modules that are never handed to the
 * bundler — an import there would resolve to a path string at runtime and the
 * bundler would never see it. Scanning keeps one rule for all three directories
 * instead of a different one per directory.
 *
 * Everything is concatenated into a single hashed file: one request, cached
 * forever, and no ordering surprises between pages.
 */
export async function buildStyles(options: {
  dirs: string[];
  outDir: string;
  dev?: boolean;
}): Promise<string | null> {
  const glob = new Bun.Glob("**/*.css");
  const sheets: string[] = [];

  for (const dir of options.dirs) {
    if (!existsSync(dir)) continue;
    for await (const match of glob.scan({ cwd: dir, onlyFiles: true, absolute: true })) {
      sheets.push(match);
    }
  }

  if (sheets.length === 0) return null;

  // Sorted so the cascade is deterministic: the same sources must always
  // produce the same bytes, or the content hash churns on every build.
  sheets.sort();

  const outDir = resolve(options.outDir);
  const entriesDir = join(outDir, "entries");
  await mkdir(entriesDir, { recursive: true });

  const entryPath = join(entriesDir, "styles.css");
  const entry = sheets
    .map((sheet) => `@import ${JSON.stringify(sheet.replace(/\\/g, "/"))};`)
    .join("\n");
  await Bun.write(entryPath, entry + "\n");

  const result = await Bun.build({
    entrypoints: [entryPath],
    outdir: join(outDir, "static"),
    minify: !options.dev,
    naming: { entry: "styles-[hash].css", asset: "[name]-[hash].[ext]" },
  });

  if (!result.success) {
    throw new Error(`Stylesheet build failed:\n${result.logs.map(String).join("\n")}`);
  }

  const css = result.outputs.find((artifact) => artifact.path.endsWith(".css"));
  if (!css) throw new Error("Stylesheet build produced no CSS output.");

  const href = `${CLIENT_ASSET_PREFIX}/${basename(css.path)}`;
  await Bun.write(join(outDir, STYLESHEET_MANIFEST_FILE), href);
  return href;
}

/**
 * Maps island name to the public URL of its entry chunk.
 *
 * One reserved key rides along: `@runtime`, the lazy-hydration chunk. It lives
 * here rather than in a file of its own because it is produced by the same
 * build and consumed at the same moment - and an island can never collide with
 * it, since island names come from filenames.
 */
export type IslandManifest = Record<string, string>;

/** Manifest key holding the lazy-hydration runtime chunk. */
export const RUNTIME_CHUNK_KEY = "@runtime";

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

/** Entry filename for the lazy-hydration runtime, before hashing. */
const RUNTIME_ENTRY_NAME = "stoneware-runtime";

function runtimeEntrySource(): string {
  return `import ${JSON.stringify("stoneware/client/runtime")};\n`;
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

  // Written together rather than one after another: these are independent
  // files, and the dev server rebuilds them on every island edit.
  await Promise.all(
    options.islands.map((island) => {
      const entryPath = join(entriesDir, `${island.chunkName}.ts`);
      entrypoints.push(entryPath);
      entryToIsland.set(island.chunkName, island);
      return Bun.write(entryPath, entrySource(island));
    }),
  );

  // Built unconditionally, referenced only by pages that have a lazy island.
  // Deciding here would mean rebuilding whenever a page changed its directives;
  // the chunk is a few hundred bytes, so it is cheaper to always emit it.
  const runtimeEntry = join(entriesDir, `${RUNTIME_ENTRY_NAME}.ts`);
  await Bun.write(runtimeEntry, runtimeEntrySource());
  entrypoints.push(runtimeEntry);

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

    if (chunkName === RUNTIME_ENTRY_NAME) {
      manifest[RUNTIME_CHUNK_KEY] = `${CLIENT_ASSET_PREFIX}/${file}`;
      continue;
    }

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
