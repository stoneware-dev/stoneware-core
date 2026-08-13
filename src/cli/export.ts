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
import { dirname, join, resolve } from "node:path";
import { buildIslands, buildStyles } from "../build.ts";
import { loadConfigFile, resolveConfig } from "../config.ts";
import { discoverIslands } from "../islands.ts";
import { createApp } from "../server.ts";
import { Router, isReservedRoute } from "../router.ts";

export interface ExportResult {
  outDir: string;
  pages: number;
  skipped: string[];
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

  const app = await createApp({ ...userConfig, root }, { dev: false });

  const router = new Router(config.routesDir);
  await router.init();

  const outDir = resolve(root, outDirName);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const skipped: string[] = [];
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

  return { outDir, pages, skipped };
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
