/**
 * Document assembly: turn a rendered route into a complete HTML response.
 *
 * A page may return a whole `<html>` document when it wants full control;
 * otherwise Stoneware wraps the markup in a minimal shell. Either way the island
 * payload and module scripts are injected just before `</body>`.
 */

import { renderIslandPayload } from "./render.ts";
import type { CollectedIsland } from "./render.ts";
import { RUNTIME_CHUNK_KEY } from "../build/build.ts";
import type { IslandManifest } from "../build/build.ts";

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
  /** Route pattern, used only to name the page in a diagnostic. */
  route?: string;
  /** Enables the checks that only catch authoring mistakes. */
  dev?: boolean;
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
    //
    // Unless it has no <head> to put any of it in, which used to be silent. A
    // route that renders <html><body> and nothing else lost the stylesheet, the
    // whole of its head() export - title, canonical, Open Graph, JSON-LD - and
    // every preload, with no output anywhere saying so. The page rendered
    // unstyled and unindexable and looked like a CSS bug.
    if (!hasHead(html)) {
      warnHeadless(options, headExtra, cspTag);
      return DOCTYPE + "\n" + injectBeforeBodyClose(html, scripts);
    }

    const withCSP = cspTag ? injectAfterHeadOpen(html, cspTag) : html;
    const withHead = headExtra ? injectBeforeHeadClose(withCSP, headExtra) : withCSP;
    return DOCTYPE + "\n" + injectBeforeBodyClose(withHead, scripts);
  }

  // A document that owns its <html> but does not start with it - a comment or
  // stray text ahead of the tag - is about to be wrapped in a second one. The
  // output is two nested documents, which is invalid and renders in a way that
  // sends people looking at their CSS.
  if (options.dev === true) warnNestedDocument(options, html);

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

function hasHead(html: string): boolean {
  return /<head[\s>]/i.test(html) && html.toLowerCase().includes("</head>");
}

/**
 * Warned-about routes, so a mistake is reported once rather than on every
 * request. A per-request warning on a page under load is its own outage.
 */
const warned = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/** Reset between tests. Not part of the public API. */
export function resetDocumentWarnings(): void {
  warned.clear();
}

/**
 * A full document with no `<head>` element.
 *
 * Reported in production as well as dev, because the consequence is a live page
 * with no stylesheet and no metadata, and the operator is the person who needs
 * to know. Naming what was dropped matters more than naming the rule: "your
 * canonical tag is missing" is actionable, "no head element" is a riddle.
 */
function warnHeadless(options: DocumentOptions, headExtra: string, cspTag: string): void {
  const lost: string[] = [];
  if (options.stylesheet) lost.push("the bundled stylesheet");
  if (options.head) lost.push("everything from the route's head() export");
  if (options.preloads && options.preloads.length > 0) lost.push("preload hints");
  if (cspTag) lost.push("the Content-Security-Policy meta tag");

  // Nothing to inject means nothing was lost, and a page may legitimately be a
  // bare <html><body> with no CSS and no metadata.
  if (lost.length === 0 && headExtra === "") return;

  const where = options.route ?? "a route";
  warnOnce(
    `headless:${where}`,
    `[stoneware] ${where} renders its own <html> but has no <head> element, so ` +
      `${lost.join(", ")} could not be added and ${lost.length === 1 ? "is" : "are"} missing from the page.\n` +
      `  Add <head></head> to the document this route returns, or return a fragment ` +
      `and let Stoneware build the document.`,
  );
}

/** A document that owns its `<html>` but does not begin with it. */
function warnNestedDocument(options: DocumentOptions, html: string): void {
  if (!/<html[\s>]/i.test(html)) return;

  const where = options.route ?? "a route";
  warnOnce(
    `nested:${where}`,
    `[stoneware] ${where} returns an <html> element that is not the first thing in ` +
      `its output, so it was treated as a fragment and wrapped in a second document.\n` +
      `  The result is nested <html> and <body> elements. Remove whatever precedes ` +
      `the <html> tag — a comment or stray text is the usual cause.`,
  );
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
