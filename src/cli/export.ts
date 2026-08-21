/**
 * `stoneware export` - prerender the site to static HTML.
 *
 * Every page is fetched through the ordinary request pipeline rather than a
 * second rendering path, so what lands on disk is byte-identical to what the
 * server would have sent. The output is plain files, which makes it deployable
 * to hosts that cannot run Bun at all - Cloudflare Pages, Netlify, GitHub Pages,
 * any CDN.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { buildIslands, buildStyles } from "../build/build.ts";
import { SECURITY_HEADERS, loadConfigFile, resolveConfig } from "../config.ts";
import { discoverIslands } from "../build/islands.ts";
import { createApp } from "../http/server.ts";
import { Router, isReservedRoute } from "../routing/router.ts";

export interface ExportResult {
  outDir: string;
  pages: number;
  skipped: string[];
  /** The policy embedded in every page, or null when the project disabled it. */
  csp: string | false;
  /** Directives that only a real header can carry, so a meta tag drops them. */
  headerOnly: string[];
  /** Links in the exported pages that resolve to nothing in the output. */
  dangling: DanglingLink[];
}

export interface DanglingLink {
  /** The exported page holding the link, as a URL path. */
  from: string;
  /** The href or src that resolves to nothing. */
  to: string;
}

/**
 * Links in the exported output that point at files the export did not write.
 *
 * The export already reports which routes it skipped, and that line is easy to
 * read past: it is one line among several, it looks informational, and the
 * command exits 0. So a site ships whose own navigation links to pages that
 * were never written, every one of them 404s, and the first anyone hears of it
 * is a visitor - or a deploy that looks perfect except for one section.
 *
 * The information to prevent that is already here. The pages have been written
 * and their links can be resolved against the very directory about to be
 * uploaded, so the check is a scan of the output rather than an analysis of the
 * project. Anything unresolvable is reported by name.
 *
 * Resolution mirrors the conventions a static host uses, which is also what
 * `stoneware preview` implements: `<path>/index.html` for a page, the literal
 * path for a file, and `<path>.html` for hosts that serve it.
 */
async function findDanglingLinks(outDir: string, pages: string[]): Promise<DanglingLink[]> {
  const dangling: DanglingLink[] = [];
  const resolved = new Map<string, boolean>();

  for (const page of pages) {
    const file = pageFile(outDir, page);
    if (!existsSync(file)) continue;

    const html = await Bun.file(file).text();
    for (const target of internalTargets(html)) {
      let ok = resolved.get(target);
      if (ok === undefined) {
        ok = await targetExists(outDir, target);
        resolved.set(target, ok);
      }
      if (!ok) dangling.push({ from: page, to: target });
    }
  }

  return dangling;
}

/** Where a given URL path was written. */
function pageFile(outDir: string, url: string): string {
  return url === "/" ? join(outDir, "index.html") : join(outDir, url.replace(/^\//, ""), "index.html");
}

/**
 * Every same-origin href and src on the page.
 *
 * `src` as well as `href` because a missing stylesheet or island chunk is the
 * same class of failure as a missing page, and the one that presents as "the
 * CSS is broken" rather than as a missing file.
 */
function internalTargets(html: string): Set<string> {
  const targets = new Set<string>();

  for (const match of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
    const raw = match[1]!;

    // Only site-absolute paths. An external origin is not ours to verify, and
    // a relative link would need the containing page's directory to resolve -
    // the framework's own helpers all emit absolute paths.
    if (!raw.startsWith("/") || raw.startsWith("//")) continue;

    // Drop the query and fragment: a static host serves the same file either
    // way, and `/about?utm=x` must not be reported as missing.
    const path = raw.split(/[?#]/)[0]!;
    if (path === "") continue;

    targets.add(path);
  }

  return targets;
}

async function targetExists(outDir: string, target: string): Promise<boolean> {
  const relative = decodeURIComponent(target).replace(/^\//, "");

  const candidates =
    target.endsWith("/") || extname(target) === ""
      ? [join(outDir, relative, "index.html"), join(outDir, `${relative.replace(/\/$/, "")}.html`)]
      : [join(outDir, relative)];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return true;
  }
  return false;
}

/**
 * A route with `[params]` cannot be enumerated on its own. The module may
 * export `staticPaths()` returning one params object per page it wants
 * generated; without it there is nothing to prerender and the route is skipped
 * rather than guessed at.
 */
type StaticPaths = () => Record<string, string>[] | Promise<Record<string, string>[]>;

export async function exportSite(root: string, outDirName = "dist"): Promise<ExportResult> {
  const userConfig = await loadConfigFile(root);
  const config = resolveConfig({ ...userConfig, root }, false);

  // Build first: a production app refuses to start without the island manifest.
  const islands = await discoverIslands(config.islandsDir);
  await buildIslands({ islands, outDir: config.outDir, dev: false });
  await buildStyles({
    dirs: [config.routesDir, config.islandsDir, join(config.root, "lib")],
    outDir: config.outDir,
    dev: false,
  });

  // The one place this is switched on. A running server sends the policy as a
  // header, which is strictly stronger; static files carry no headers, so an
  // export either embeds what it can or ships with no policy at all.
  const app = await createApp(
    {
      ...userConfig,
      root,
      // An export prerenders every page by fetching it through the ordinary
      // pipeline, but nobody is visiting - these are build-time requests. A
      // project whose `observe` ships to a metrics backend would otherwise see
      // a burst of synthetic traffic at every build, dated to the build and
      // indistinguishable from the real thing.
      observe: undefined,
    },
    { dev: false, embedCSPMeta: true },
  );

  const router = new Router(config.routesDir);
  await router.init();

  const outDir = resolve(root, outDirName);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const skipped: string[] = [];
  /** URL paths of the HTML pages written, for the link check at the end. */
  const written: string[] = [];
  let pages = 0;

  for (const [pattern, filePath] of Object.entries(router.routes)) {
    // `_404` and friends are conventions, not pages; the router refuses to
    // serve them, so fetching one here would look like a broken route.
    if (isReservedRoute(pattern)) continue;

    const urls = await expand(pattern, filePath, skipped);

    for (const url of urls) {
      const response = await app.fetch(new Request(`http://export.local${url}`));

      // Only pages are prerenderable. An action route has no GET, and a route
      // that errors should fail the export rather than write a broken file.
      if (response.status === 405) {
        skipped.push(`${pattern} (server action)`);
        break;
      }
      if (!response.ok) {
        throw new Error(`${url} returned ${response.status} during export`);
      }

      // Not every GET route is a page. A sitemap, a robots.txt or a JSON feed
      // must land at its literal path - written as `<path>/index.html` it is
      // unreachable at the URL a crawler will ask for.
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) {
        await writeFileAt(outDir, url, await response.bytes());
        pages++;
        continue;
      }

      const html = await response.text();

      // A prerendered page cannot carry a CSRF token: the token would be frozen
      // into the file and handed to every visitor. Fail loudly - silently
      // shipping one would defeat the protection.
      if (html.includes(`name="${config.csrf.fieldName}"`)) {
        // Never write it: a frozen token would be handed to every visitor, and
        // the same token for everyone is no protection at all. Skipping keeps
        // the rest of the export usable while leaving the omission visible in
        // the summary, rather than failing a fifty-page site over one form.
        skipped.push(`${url} (renders a CSRF token)`);
        continue;
      }

      await writePage(outDir, url, html);
      written.push(url);
      pages++;
    }
  }

  // A 404 has no URL of its own, so it is requested rather than routed to: any
  // path that cannot match produces it. Cloudflare Pages, Netlify and GitHub
  // Pages all serve /404.html for a miss, so that is where it goes.
  const missing = await app.fetch(new Request("http://export.local/_stoneware_not_found"));
  if (missing.status === 404) {
    await Bun.write(join(outDir, "404.html"), await missing.text());
  }

  // Client chunks and the stylesheet, then anything in public/. public/ goes
  // last so a project can deliberately shadow a generated file.
  const staticDir = join(config.outDir, "static");
  if (existsSync(staticDir)) {
    await cp(staticDir, join(outDir, "_stoneware"), { recursive: true });
  }
  if (existsSync(config.publicDir)) {
    await cp(config.publicDir, outDir, { recursive: true });
  }

  const headerOnly = await writeHostHeaders(outDir, config.csp);

  // Last, deliberately: public/ and the client chunks have been copied in by
  // now, so a link to an image or a stylesheet resolves against what will
  // actually be uploaded rather than against a half-populated directory.
  const dangling = await findDanglingLinks(outDir, written);

  return { outDir, pages, skipped, csp: config.csp, headerOnly, dangling };
}

async function expand(
  pattern: string,
  filePath: string,
  skipped: string[],
): Promise<string[]> {
  if (!pattern.includes("[")) return [pattern];

  const module = (await import(Bun.pathToFileURL(filePath).href)) as {
    staticPaths?: StaticPaths;
  };

  if (typeof module.staticPaths !== "function") {
    skipped.push(`${pattern} (no staticPaths export)`);
    return [];
  }

  const entries = await module.staticPaths();
  return entries.map((params) => {
    let url = pattern;
    for (const [key, value] of Object.entries(params)) {
      url = url.replace(`[${key}]`, encodeURIComponent(value));
    }
    return url;
  });
}

/**
 * Write a non-HTML response at its literal path, extension intact.
 *
 * `/sitemap.xml` has to be readable at `/sitemap.xml`; giving it the directory
 * treatment below would put it at `/sitemap.xml/` and no crawler would find it.
 */
async function writeFileAt(outDir: string, url: string, bytes: Uint8Array): Promise<void> {
  const target = join(outDir, url.replace(/^\//, ""));
  await mkdir(dirname(target), { recursive: true });
  await Bun.write(target, bytes);
}

/**
 * `/docs/why` becomes `docs/why/index.html` rather than `docs/why.html`, so a
 * static host serves it at the same URL the dev server used - no trailing-slash
 * redirect and no per-host rewrite rules.
 */
async function writePage(outDir: string, url: string, html: string): Promise<void> {
  const relative = url === "/" ? "index.html" : join(url.replace(/^\//, ""), "index.html");
  const target = join(outDir, relative);
  await mkdir(dirname(target), { recursive: true });
  await Bun.write(target, html);
}

/**
 * Write a `_headers` file, so hosts that read one send the real thing.
 *
 * Netlify and Cloudflare Pages both consume this format, and it is inert
 * everywhere else - a stray text file on GitHub Pages costs nothing. It carries
 * the full policy including `frame-ancestors`, which the embedded meta tag
 * cannot express, so on those two hosts the export is protected exactly as the
 * server would protect it.
 *
 * Returns the directives that only a header can carry, so the CLI can say what
 * a host without header support is giving up rather than implying parity.
 */
async function writeHostHeaders(outDir: string, csp: string | false): Promise<string[]> {
  const lines = ["/*"];

  if (csp !== false) lines.push(`  Content-Security-Policy: ${csp}`);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    lines.push(`  ${name}: ${value}`);
  }

  await Bun.write(join(outDir, "_headers"), lines.join("\n") + "\n");

  if (csp === false) return [];
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => /^(frame-ancestors|report-uri|report-to|sandbox)\b/i.test(directive));
}
