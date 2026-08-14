/**
 * `stoneware preview` - serve a static export the way a static host would.
 *
 * Not a convenience wrapper around any file server. The export has conventions a
 * generic one does not reproduce: a page is written to `<path>/index.html` so it
 * answers at the URL the dev server used, and a miss is answered from
 * `404.html`, which is the filename Cloudflare Pages, Netlify and GitHub Pages
 * each look for. Serving `dist/` with something that does neither tells you
 * nothing about whether the deploy will work.
 *
 * Before this existed, the only way to check an export was to deploy it.
 *
 * What it deliberately does *not* do is add the framework's security headers. A
 * Content-Security-Policy is a response header, and static files do not carry
 * one - so an exported site has no CSP until the host is configured to send it.
 * A preview that quietly added the header back would hide exactly the difference
 * it exists to show, so it prints the warning instead.
 */

import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { listen } from "../listen.ts";
import { safeJoin } from "../server.ts";

export interface PreviewResult {
  dir: string;
  port: number;
  hostname: string;
  /** Returned so a caller that started it can stop it - tests, mainly. */
  server: Bun.Server<undefined>;
}

export async function preview(
  root: string,
  outDirName = "dist",
  port = Number(Bun.env.PORT ?? 4173),
): Promise<PreviewResult> {
  const dir = resolve(root, outDirName);

  if (!existsSync(dir)) {
    throw new Error(
      `No export found at ${dir}.\nRun \`stoneware export\` first, or pass --out <dir>.`,
    );
  }

  const notFoundPage = join(dir, "404.html");
  const hasNotFoundPage = existsSync(notFoundPage);

  const server = await listen({
    port,
    hostname: "localhost",
    allowPortFallback: true,
    async fetch(request) {
      const { pathname } = new URL(request.url);

      const file = await resolveFile(dir, pathname);
      if (file) {
        return new Response(file, {
          headers: {
            // No CSP and no security headers, deliberately - see the note above.
            // What a static host sends is what this sends.
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      if (hasNotFoundPage) {
        return new Response(Bun.file(notFoundPage), {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return { dir, port: server.port ?? port, hostname: String(server.hostname), server };
}

/**
 * Map a request path to a file on disk, following the export's own layout.
 *
 * `safeJoin` is imported rather than reimplemented: it is the same lexical and
 * symlink checking the real server uses, and a second copy of path-safety logic
 * is how one of them ends up wrong.
 */
async function resolveFile(dir: string, pathname: string): Promise<Bun.BunFile | null> {
  const candidates = extname(pathname)
    ? [pathname]
    : // A page lives at <path>/index.html. Both spellings of the URL reach it,
      // because a static host serves the same file for either.
      [join(pathname, "index.html"), `${pathname.replace(/\/$/, "")}.html`];

  for (const candidate of candidates) {
    const target = safeJoin(dir, candidate);
    if (!target) continue;

    const file = Bun.file(target);
    if (await file.exists()) return file;
  }

  return null;
}

/** Human-readable summary for the CLI, including what a static host will not send. */
export function describePreview(result: PreviewResult, root: string): string {
  const lines = [
    `  serving  ${result.dir.replace(root, ".").replace(/\\/g, "/")}`,
    `  url      http://${result.hostname}:${result.port}`,
    ``,
    `  This mirrors a static host: no Content-Security-Policy and no security`,
    `  headers, because static files cannot carry response headers. Configure`,
    `  them on the host - _headers on Netlify and Cloudflare Pages, or the`,
    `  equivalent - or the exported site ships without the policy the server`,
    `  applies automatically.`,
  ];
  return lines.join("\n");
}
