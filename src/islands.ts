/**
 * Island discovery.
 *
 * A file is an island because of where it lives, not because of a directive
 * inside it (CLAUDE.md §5). Nothing under `routes/` can ever ship JS; everything
 * under `islands/` does.
 */

import { relative, resolve } from "node:path";
import { directoryExists } from "./router.ts";
import type { Component } from "./types.ts";

export interface IslandEntry {
  /** Stable identifier derived from the path, e.g. `Counter` or `forms/Newsletter`. */
  name: string;
  /** Absolute path to the island source file. */
  path: string;
  /** Filename-safe form of `name`, used for bundle output. */
  chunkName: string;
}

export interface LoadedIsland extends IslandEntry {
  component: Component<any>;
}

const ISLAND_GLOB = "**/*.{tsx,jsx,ts,js}";

/** Find every island source file under `islandsDir`, sorted for stable output. */
export async function discoverIslands(islandsDir: string): Promise<IslandEntry[]> {
  const dir = resolve(islandsDir);
  if (!directoryExists(dir)) return [];

  const glob = new Bun.Glob(ISLAND_GLOB);
  const entries: IslandEntry[] = [];

  for await (const match of glob.scan({ cwd: dir, onlyFiles: true, absolute: true })) {
    const name = toIslandName(dir, match);
    entries.push({ name, path: match, chunkName: name.replace(/\//g, "-") });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function toIslandName(islandsDir: string, filePath: string): string {
  return relative(islandsDir, filePath)
    .replace(/\\/g, "/")
    .replace(/\.(tsx|jsx|ts|js)$/, "");
}

/**
 * Import each island and map its default export to its name.
 *
 * The renderer identifies islands by function identity, so this map is what
 * makes a component hydrate: importing the same function from anywhere marks it
 * as an island.
 */
export async function loadIslands(entries: IslandEntry[]): Promise<LoadedIsland[]> {
  const loaded: LoadedIsland[] = [];

  for (const entry of entries) {
    const module = await import(Bun.pathToFileURL(entry.path).href);
    const component = module.default;

    if (typeof component !== "function") {
      throw new Error(
        `Island "${entry.name}" (${entry.path}) must export a component function as its ` +
          `default export.`,
      );
    }
    loaded.push({ ...entry, component });
  }

  return loaded;
}

export function buildIslandRegistry(islands: LoadedIsland[]): Map<Component<any>, string> {
  const registry = new Map<Component<any>, string>();
  for (const island of islands) registry.set(island.component, island.name);
  return registry;
}
