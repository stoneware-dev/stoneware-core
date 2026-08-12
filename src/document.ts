/**
 * Document assembly: turn a rendered route into a complete HTML response.
 *
 * A page may return a whole `<html>` document when it wants full control;
 * otherwise Sinter wraps the markup in a minimal shell. Either way the island
 * payload and module scripts are injected just before `</body>`.
 */

import { renderIslandPayload } from "./render.ts";
import type { CollectedIsland } from "./render.ts";
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
}

const DOCTYPE = "<!DOCTYPE html>";

export function buildDocument(options: DocumentOptions): string {
  const { html, islands, manifest } = options;
  const scripts =
    renderIslandPayload(islands) + renderIslandScripts(islands, manifest) + (options.suffix ?? "");

  if (isFullDocument(html)) {
    return DOCTYPE + "\n" + injectBeforeBodyClose(html, scripts);
  }

  const lang = options.lang ?? "en";
  const title = escapeTitle(options.title ?? "");

  return (
    `${DOCTYPE}\n<html lang="${lang}">` +
    `<head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${title}</title></head>` +
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
    if (seen.has(island.name)) continue;
    seen.add(island.name);

    const src = manifest[island.name];
    if (!src) {
      throw new Error(
        `Island "${island.name}" was rendered but has no client bundle. ` +
          `Run the island build before serving, or restart the dev server.`,
      );
    }
    out += `<script type="module" src="${Bun.escapeHTML(src)}"></script>`;
  }

  return out;
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
