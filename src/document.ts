/**
 * Document assembly: turn a rendered route into a complete HTML response.
 *
 * A page may return a whole `<html>` document when it wants full control;
 * otherwise Stoneware wraps the markup in a minimal shell. Either way the island
 * payload and module scripts are injected just before `</body>`.
 */

import { renderIslandPayload } from "./render.ts";
import type { CollectedIsland } from "./render.ts";
import { RUNTIME_CHUNK_KEY } from "./build.ts";
import type { IslandManifest } from "./build.ts";

export interface DocumentOptions {
  /** Markup produced by the route. */
  html: string;
  islands: CollectedIsland[];
  manifest: IslandManifest;
  /** Title used only by the fallback shell. */
  title?: string;
  lang?: string;
  /** Extra markup appended after the island scripts. Dev-server use only. */
  suffix?: string;
  /** Hashed URL of the bundled co-located stylesheet, when the project has CSS. */
  stylesheet?: string | null;
}

const DOCTYPE = "<!DOCTYPE html>";

export function buildDocument(options: DocumentOptions): string {
  const { html, islands, manifest } = options;

  const eager = new Set(islands.filter((i) => i.strategy === "load").map((i) => i.name));
  const lazy = islands.filter((i) => i.strategy !== "load");

  // An island with no eager instance on this page has no module script, so the
  // runtime needs its URL to fetch it when a trigger fires. One with an eager
  // instance is already being downloaded, so listing it here would be dead
  // weight in the HTML.
  const chunks: Record<string, string> = {};
  for (const island of lazy) {
    if (eager.has(island.name)) continue;
    chunks[island.name] = resolveChunk(island.name, manifest);
  }

  const scripts =
    renderIslandPayload(islands, chunks) +
    renderIslandScripts(islands, manifest) +
    renderRuntimeScript(lazy.length > 0, manifest) +
    (options.suffix ?? "");

  if (isFullDocument(html)) {
    // A page that owns its whole document still gets the bundled stylesheet:
    // co-located CSS is collected by the build, so there is no <link> for the
    // author to write and none to forget.
    const withStyles = options.stylesheet
      ? injectBeforeHeadClose(html, styleLink(options.stylesheet))
      : html;
    return DOCTYPE + "\n" + injectBeforeBodyClose(withStyles, scripts);
  }

  const lang = options.lang ?? "en";
  const title = escapeTitle(options.title ?? "");

  return (
    `${DOCTYPE}\n<html lang="${lang}">` +
    `<head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title}</title>` +
    (options.stylesheet ? styleLink(options.stylesheet) : "") +
    `</head>` +
    `<body>${html}${scripts}</body></html>`
  );
}

function isFullDocument(html: string): boolean {
  return /^\s*(<!DOCTYPE[^>]*>\s*)?<html[\s>]/i.test(html);
}

function escapeTitle(title: string): string {
  return Bun.escapeHTML(title);
}

/**
 * One module script per distinct island on the page.
 *
 * `type="module"` gives deferred execution for free, so the scripts sit at the
 * end of `<body>` without blocking parsing. An island that appears three times
 * still loads one bundle; `hydrate()` finds all three instances.
 */
function renderIslandScripts(islands: CollectedIsland[], manifest: IslandManifest): string {
  const seen = new Set<string>();
  let out = "";

  for (const island of islands) {
    // A lazily-hydrated instance is exactly the one that must not produce a
    // script tag: the whole saving is in not fetching the chunk up front.
    if (island.strategy !== "load") continue;
    if (seen.has(island.name)) continue;
    seen.add(island.name);

    out += `<script type="module" src="${Bun.escapeHTML(resolveChunk(island.name, manifest))}"></script>`;
  }

  return out;
}

/**
 * The lazy-hydration runtime, loaded only by pages that have a deferred island.
 *
 * A page whose islands are all eager never sees this tag, so adding directives
 * to the framework costs nothing to pages that do not use them.
 */
function renderRuntimeScript(needed: boolean, manifest: IslandManifest): string {
  if (!needed) return "";

  const src = manifest[RUNTIME_CHUNK_KEY];
  if (!src) {
    throw new Error(
      `A lazily-hydrated island was rendered but the hydration runtime is missing ` +
        `from the island manifest. Run \`stoneware build\` again — the manifest predates ` +
        `lazy hydration support.`,
    );
  }

  return `<script type="module" src="${Bun.escapeHTML(src)}"></script>`;
}

function resolveChunk(name: string, manifest: IslandManifest): string {
  const src = manifest[name];
  if (!src) {
    throw new Error(
      `Island "${name}" was rendered but has no client bundle. ` +
        `Run the island build before serving, or restart the dev server.`,
    );
  }
  return src;
}

/**
 * Insert markup before the closing `</body>`.
 *
 * Matching the *last* occurrence avoids being fooled by the string appearing in
 * page content earlier in the document.
 */
function injectBeforeBodyClose(html: string, injection: string): string {
  if (injection === "") return html;

  const index = html.toLowerCase().lastIndexOf("</body>");
  if (index === -1) return html + injection;
  return html.slice(0, index) + injection + html.slice(index);
}

function styleLink(href: string): string {
  return `<link rel="stylesheet" href="${Bun.escapeHTML(href)}">`;
}

/**
 * Put the stylesheet in <head>, where a browser can start fetching it before it
 * has parsed the body. Matching the *first* </head> is right here: unlike
 * </body>, it cannot plausibly appear in page content before the real one.
 */
function injectBeforeHeadClose(html: string, injection: string): string {
  const index = html.toLowerCase().indexOf("</head>");
  if (index === -1) return html;
  return html.slice(0, index) + injection + html.slice(index);
}
