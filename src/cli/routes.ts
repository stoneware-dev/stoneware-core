/**
 * `stoneware routes` - print the route table, in the order it is matched.
 *
 * Order is the point. Matching no longer goes through `Bun.FileSystemRouter`;
 * patterns are compiled and sorted most-specific-first, so a literal beats a
 * param beats a catch-all. That is invisible from the filesystem: nothing about
 * the names of `routes/docs/[slug].tsx` and `routes/docs/index.tsx` says which
 * one `/docs` reaches.
 *
 * Reserved routes are listed rather than hidden. `_404` and `_middleware` are
 * real files doing real work, and leaving them out of the listing invites the
 * conclusion that they were not picked up.
 */

import { relative } from "node:path";
import { loadConfigFile, resolveConfig } from "../config.ts";
import { compileRoutes } from "../routing/route-table.ts";
import { Router, isReservedRoute } from "../routing/router.ts";

export type RouteKind = "page" | "action" | "reserved" | "unknown";

export interface RouteRow {
  pattern: string;
  file: string;
  kind: RouteKind;
  methods: string[];
}

export interface RoutesResult {
  rows: RouteRow[];
  root: string;
}

const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

export async function listRoutes(root: string): Promise<RoutesResult> {
  const userConfig = await loadConfigFile(root);
  const config = resolveConfig({ ...userConfig, root }, false);

  const router = new Router(config.routesDir);
  await router.init();

  // Compiled, not the raw table: this is the order requests are actually tried
  // in, which is the question the command exists to answer.
  const compiled = compileRoutes(router.routes).all;

  const rows: RouteRow[] = [];
  for (const route of compiled) {
    rows.push({
      pattern: route.pattern,
      file: relative(root, route.filePath).replace(/\\/g, "/"),
      ...(await classify(route.pattern, route.filePath)),
    });
  }

  return { rows, root };
}

/**
 * Page or server action, by looking at what the module exports.
 *
 * Importing is the only way to know - the distinction is "default export" vs
 * "HTTP method exports", which is not visible in the filename. A module that
 * throws on import is reported as unknown rather than taking the command down
 * with it: a listing is most useful precisely when something is broken.
 */
async function classify(
  pattern: string,
  filePath: string,
): Promise<{ kind: RouteKind; methods: string[] }> {
  if (isReservedRoute(pattern)) return { kind: "reserved", methods: [] };

  try {
    const module = (await import(Bun.pathToFileURL(filePath).href)) as Record<string, unknown>;

    const methods = HTTP_METHODS.filter((method) => typeof module[method] === "function");
    if (methods.length > 0) return { kind: "action", methods };
    if (typeof module.default === "function") return { kind: "page", methods: ["GET"] };

    return { kind: "unknown", methods: [] };
  } catch {
    return { kind: "unknown", methods: [] };
  }
}

export function describeRoutes(result: RoutesResult): string {
  if (result.rows.length === 0) return "  no routes found";

  const width = Math.max(...result.rows.map((row) => row.pattern.length));
  const lines: string[] = [];

  for (const row of result.rows) {
    const label =
      row.kind === "reserved"
        ? "reserved"
        : row.kind === "unknown"
          ? "unknown"
          : row.methods.join(", ");

    lines.push(`  ${row.pattern.padEnd(width)}  ${label.padEnd(22)}  ${row.file}`);
  }

  lines.push("");
  lines.push(`  ${result.rows.length} route(s), listed in match order.`);

  const unknown = result.rows.filter((row) => row.kind === "unknown");
  if (unknown.length > 0) {
    lines.push(
      `  ${unknown.length} could not be classified - a module that fails to import, or one`,
      `  exporting neither a default component nor any HTTP method handler.`,
    );
  }

  return lines.join("\n");
}
