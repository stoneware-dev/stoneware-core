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
  /** Markup from the route's `head` export, already rendered to a string. */
  head?: string;
  /**
   * A Content-Security-Policy to embed as `<meta http-equiv>`.
   *
   * Only set by `stoneware export`. A CSP is normally a response header, and a
   * directory of static files cannot carry one - so an exported site has no
   * policy at all unless the host is configured to send it, which silently
   * loses the defence the server applies for free.
   */
  cspMeta?: string | null;
  /** `<link rel="preload">` tags collected during the body render. */
  preloads?: string[];
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

  // Preloads first: they are the reason the browser can start a download
  // early, so anything that delays them defeats the point.
  const headExtra =
    (options.preloads ?? []).join("") +
    (options.head ?? "") +
    (options.stylesheet ? styleLink(options.stylesheet) : "");

  // A meta policy only governs what is declared *after* it, so it goes as early
  // in the head as it can - ahead of any preload, stylesheet or script.
  const cspTag = options.cspMeta ? metaCSP(options.cspMeta) : "";

  if (isFullDocument(html)) {
    // A page that owns its whole document still gets the bundled stylesheet:
    // co-located CSS is collected by the build, so there is no <link> for the
    // author to write and none to forget.
    const withCSP = cspTag ? injectAfterHeadOpen(html, cspTag) : html;
    const withHead = headExtra ? injectBeforeHeadClose(withCSP, headExtra) : withCSP;
    return DOCTYPE + "\n" + injectBeforeBodyClose(withHead, scripts);
  }

  const lang = options.lang ?? "en";

  // A `head` export that supplies its own <title> replaces the default rather
  // than joining it - two titles in one document is never what was meant.
  const title = hasTitle(options.head) ? "" : `<title>${escapeTitle(options.title ?? "")}</title>`;

  return (
    `${DOCTYPE}\n<html lang="${lang}">` +
    // charset stays first: it has to appear within the first 1024 bytes, and a
    // parser that has not reached it yet is guessing at the bytes that follow.
    `<head><meta charset="utf-8">` +
    cspTag +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    title +
    headExtra +
    `</head>` +
    `<body>${html}${scripts}</body></html>`
  );
}

function hasTitle(head: string | undefined): boolean {
  return head !== undefined && /<title[\s>]/i.test(head);
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
 * Directives a meta policy cannot express.
 *
 * `frame-ancestors`, `report-uri` and `sandbox` are ignored when delivered in a
 * meta tag - the spec says so, and browsers comply silently. Emitting them there
 * would suggest a protection that is not present, so they are dropped and the
 * export reports what a header-less host loses.
 */
const HEADER_ONLY_DIRECTIVES = /^\s*(frame-ancestors|report-uri|report-to|sandbox)\b/i;

/** Strip the header-only directives and render the tag. */
export function metaCSP(policy: string): string {
  const usable = policy
    .split(";")
    .filter((directive) => directive.trim() !== "" && !HEADER_ONLY_DIRECTIVES.test(directive))
    .map((directive) => directive.trim())
    .join("; ");

  if (usable === "") return "";
  return `<meta http-equiv="Content-Security-Policy" content="${Bun.escapeHTML(usable)}">`;
}

/**
 * Insert at the top of `<head>`, but after a charset declaration if one is
 * already there.
 *
 * Two constraints pull in opposite directions and both are satisfiable. A
 * charset has to appear within the first 1024 bytes, because until the parser
 * reaches it every byte is a guess. A meta policy only governs what is declared
 * *after* it, so it has to precede the first stylesheet, preload or script.
 * Slotting in between honours both, and a page that declares no charset simply
 * gets the policy first.
 */
function injectAfterHeadOpen(html: string, injection: string): string {
  // Matches `<head>` and `<head lang="...">` alike; the tag ends at the first
  // `>` because a head element carries no attribute that could contain one.
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return html;

  let at = head.index + head[0].length;

  // Only a charset that already sits at the very top of the head: one appearing
  // after a stylesheet is too late to step around.
  const charset = /^\s*<meta[^>]*charset[^>]*>/i.exec(html.slice(at));
  if (charset) at += charset[0].length;

  return html.slice(0, at) + injection + html.slice(at);
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
