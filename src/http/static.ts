/**
 * Serving files from a directory: containment, the negative path index, and
 * revalidation.
 *
 * Split out of server.ts because it is the one part of the pipeline that
 * answers a request without consulting a route, a config or a renderer. Every
 * defence a static path needs lives here — traversal, dotfiles, symlinks
 * escaping the root, and the case-folding Windows forces on the index — so a
 * change to any of them is a change to one file.
 *
 * Nothing here reads `ResolvedConfig`. The two options that vary per project,
 * `followSymlinks` and dev mode, arrive as arguments, which is what lets these
 * functions be tested directly rather than through an app.
 */

import { join, resolve, sep } from "node:path";
import { existsSync, readdirSync, realpathSync } from "node:fs";

/**
 * Path segments a static request may never reach.
 *
 * Dotfiles are refused because nothing anyone deliberately publishes begins
 * with a dot, while several things nobody wants published do: `.env`,
 * `.git/config`, `.DS_Store`, editor backups. `public/` is documented as
 * "served as-is", and this is the one exception - nginx, Apache, Vercel and
 * Netlify all make it, for the same reason.
 *
 * `.well-known/` is the deliberate exception to the exception: ACME challenges,
 * `security.txt` and app-association files all live there by specification.
 */
function isHiddenPath(decoded: string): boolean {
  return decoded
    .split("/")
    .some((segment) => segment.startsWith(".") && segment !== "." && segment !== ".well-known");
}

/**
 * The resolved form of a served root, remembered for the process.
 *
 * The root may itself sit behind a link - a project under a symlinked home
 * directory, say - so both sides of the comparison have to be resolved or every
 * path looks like an escape. Resolving the root is the half that cannot change
 * between requests, and it was being repeated on every one.
 *
 * Caching it adds no assumption the framework did not already make: `publicDir`
 * and `outDir` are resolved once, at `createApp`, and held in `ResolvedConfig`
 * for the life of the process. A deploy that swaps what those paths point at
 * replaces the process along with them.
 */
const resolvedRoots = new Map<string, string>();

function realRootOf(root: string): string | null {
  const cached = resolvedRoots.get(root);
  if (cached !== undefined) return cached;

  try {
    const real = realpathSync(root);
    // Only a success is remembered. Caching the failure would be permanent, and
    // a root that does not resolve yet is a state a dev server can leave - a
    // project that has not created public/ at the moment of the first request.
    // Nothing is gained by making that stick.
    resolvedRoots.set(root, real);
    return real;
  } catch {
    return null;
  }
}

/**
 * Is the file this path opens still inside the root?
 *
 * `safeJoin` answers that lexically, which is not the same question. A symlink
 * is resolved when the file is opened, so a link inside `public/` passes a
 * textual check and then serves whatever it points at - verified against a
 * junction that served the framework's own source.
 *
 * Resolved with `realpathSync` rather than by inspecting the link, because only
 * the fully resolved path accounts for a link partway along the directory
 * chain. A path that cannot be resolved does not exist, and the caller treats
 * that the same as a miss.
 */
function resolvesInsideRoot(root: string, target: string): boolean {
  const realRoot = realRootOf(root);
  if (realRoot === null) return false;

  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return false;
  }

  return real === realRoot || real.startsWith(realRoot + sep);
}

/**
 * The set of paths a served directory actually contains, read once at startup.
 *
 * Every page request used to pay a synchronous `existsSync` that was always
 * going to miss: `public/` holds no file called `/articles/some-slug`, but the
 * only way to learn that was to ask the filesystem. Measured at 25 concurrent
 * connections that one blocking call cost about a quarter of the throughput,
 * because a synchronous syscall on the event loop serialises every request
 * behind it.
 *
 * This is a *negative* index and nothing more. A path that is not in it is
 * answered as a miss with no syscall; a path that is in it goes through
 * `safeJoin` and the existence check exactly as before, so every traversal,
 * symlink and dotfile defence still runs on the path that matters. The index
 * can only ever cause a 404 where a file was not present at startup — it can
 * never cause a file to be served that the checks would have refused.
 *
 * Not used in dev, where files appear and disappear while the server runs.
 */
export interface StaticIndex {
  has(pathname: string): boolean;
  /**
   * Metadata for paths already served once, so a repeat request costs one file
   * open rather than four stats. Populated on the way out, never at startup —
   * a directory of ten thousand assets should not pay to stat all of them
   * because one was requested.
   */
  meta: Map<string, StaticMeta>;
}

/**
 * Walk a directory into a lookup set.
 *
 * Returns null — meaning "ask the filesystem every time" — when the directory
 * cannot be read, or when anything inside it is a symlink. A link may point at
 * a directory whose children this walk would not see, and answering 404 for a
 * file that exists is a worse failure than the syscall this avoids.
 */
export function buildStaticIndex(rootDir: string): StaticIndex | null {
  // Windows matches filenames case-insensitively, so the index has to as well,
  // or it would answer 404 for a request the filesystem would have served and
  // dev (which does not use the index) would silently disagree with production.
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);

  const paths = new Set<string>();
  let sawSymlink = false;

  const walk = (dir: string, prefix: string): boolean => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        sawSymlink = true;
        return false;
      }
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!walk(join(dir, entry.name), path)) return false;
      } else if (entry.isFile()) {
        paths.add(fold(path));
      }
    }
    return true;
  };

  if (!existsSync(rootDir)) return { has: () => false, meta: new Map() };
  if (!walk(rootDir, "")) return null;
  if (sawSymlink) return null;

  return {
    meta: new Map<string, StaticMeta>(),
    has(pathname: string) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        // Undecodable is not in the index, but safeJoin owns rejecting it and
        // says so more precisely. Let it through to be refused properly.
        return true;
      }
      return paths.has(fold(decoded));
    },
  };
}

/**
 * Resolve a URL path inside a directory, refusing anything that escapes it.
 *
 * Returns `null` for traversal attempts rather than throwing, so the caller
 * treats them as ordinary 404s and leaks nothing about the layout on disk.
 */
export function safeJoin(
  rootDir: string,
  relativePath: string,
  followSymlinks = false,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) return null;
  if (isHiddenPath(decoded)) return null;

  const root = resolve(rootDir);
  const target = resolve(root, "." + (decoded.startsWith("/") ? decoded : `/${decoded}`));

  if (target !== root && !target.startsWith(root + sep)) return null;

  // The lexical check above is not enough on its own: it reasons about the
  // path, and the filesystem reasons about the link.
  if (!followSymlinks) {
    // Existence first, and only then the link check. A path that resolves to
    // nothing cannot escape anywhere, so the answer is the same either way -
    // but `realpathSync` reports a missing file by throwing, and building an
    // exception is not free. Every request that is on its way to the router
    // passes through here and matches no file, which made that throw one of
    // the few unconditional costs on the page path.
    if (!existsSync(target)) return null;
    if (!resolvesInsideRoot(root, target)) return null;
  }

  return target;
}

/**
 * Content types for the files a client build emits.
 *
 * Small and closed on purpose: this serves the framework's own output, which is
 * JavaScript, CSS, source maps, and whatever a stylesheet pulled in beside them
 * through `asset: "[name]-[hash].[ext]"`. Anything unrecognised is served as
 * bytes rather than guessed at - a wrong `Content-Type` with `nosniff` set is
 * worse than none.
 */
const ASSET_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  map: "application/json; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
};

/** Serve a chunk the build carried inside the bundle. */
export function inlineAssetResponse(name: string, base64: string, dev: boolean): Response {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();

  return new Response(Buffer.from(base64, "base64"), {
    headers: {
      "Content-Type": ASSET_TYPES[extension] ?? "application/octet-stream",
      // Content-hashed filenames, so these can never change under the name.
      "Cache-Control": dev ? "no-store" : "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Serve a file from `public/`, if one is there.
 *
 * Unlike the built chunks, these filenames carry no content hash, so they must
 * never be cached without a way to check them. An earlier version sent
 * `max-age=3600` and no validator at all, which meant a deployed change to a
 * stylesheet or an image stayed invisible to returning visitors for an hour —
 * the browser had no mechanism to ask whether it had changed.
 *
 * `no-cache` does not mean "do not store": it means "revalidate before use".
 * Paired with a validator, a repeat visit costs one 304 with an empty body, and
 * an updated file is picked up immediately.
 *
 * The validator is derived from size and mtime rather than hashing the bytes,
 * so it stays O(1) per request. It is marked weak (`W/`) because that is
 * exactly what it is — two files can share both values.
 */
export async function serveStaticIfExists(
  request: Request,
  rootDir: string,
  pathname: string,
  dev: boolean,
  followSymlinks: boolean,
  /**
   * The filename carries a content hash, so the bytes can never change under
   * it. Those are cacheable for a year; everything else has to revalidate.
   */
  immutable = false,
  /**
   * Startup listing of `rootDir`, when one could be built. A path it does not
   * contain is answered without touching the filesystem — see buildStaticIndex.
   */
  index: StaticIndex | null = null,
): Promise<Response | null> {
  if (pathname === "/" || pathname.endsWith("/")) return null;

  // Before safeJoin, because safeJoin is where the blocking stat lives.
  if (index !== null && !index.has(pathname)) return null;

  // A path resolved once is resolved again from what was learned the first
  // time. Resolving is the expensive half: `existsSync` in safeJoin costs
  // ~0.015ms and the `realpathSync` behind the link check ~0.087ms, against
  // ~0.008ms to read a file's size and mtime. So the path is remembered and the
  // validator is not.
  //
  // Remembering the validator as well was a mistake. A file replaced under a
  // running server then kept its old ETag: the new bytes were served with the
  // old tag, and a client holding that tag revalidated to 304 for as long as
  // the process lived. Correct bytes, stale validator, silent, and permanent
  // from the client's side.
  //
  // The security checks are not skipped by the cache, they are already done:
  // nothing reaches it without having passed safeJoin.
  const cached = index?.meta.get(pathname);
  if (cached !== undefined) {
    return staticResponse(request, cached.target, dev, immutable);
  }

  const target = safeJoin(rootDir, pathname, followSymlinks);
  if (!target) return null;

  const response = await staticResponse(request, target, dev, immutable);
  if (response === null) return null;

  // Only in production, and only behind an index — the same assumption the
  // index already makes, that the set of files in a served directory does not
  // change under a running server. What may change is their contents, which is
  // why only the path is kept.
  if (index !== null && !dev) index.meta.set(pathname, { target });

  return response;
}

/** What a served file is remembered as: where it is, and nothing about it. */
interface StaticMeta {
  target: string;
}

/**
 * Build the response for a resolved path.
 *
 * Returns null when the file is not there, which the caller treats as a miss —
 * a path can be indexed at startup and deleted afterwards.
 */
async function staticResponse(
  request: Request,
  target: string,
  dev: boolean,
  immutable: boolean,
): Promise<Response | null> {
  // A fresh BunFile per request, deliberately: one held across requests answers
  // `size` and `lastModified` from the stat it took the first time, which is
  // the same staleness this function exists to avoid.
  const file = Bun.file(target);

  if (immutable) {
    // Content-hashed filename, so the bytes cannot change under it. There is no
    // validator to go stale and nothing to re-read — the one case where
    // remembering everything is provably safe.
    return new Response(file, {
      headers: {
        "Cache-Control": dev ? "no-store" : "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  if (!(await file.exists())) return null;

  const headers: Record<string, string> = {
    "Cache-Control": dev ? "no-store" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  };

  if (!dev) {
    // Read now, for this response. These are what the client will revalidate
    // against, so they have to describe the bytes being sent.
    const lastModified = file.lastModified;
    const etag = `W/"${file.size.toString(16)}-${lastModified.toString(16)}"`;
    headers.ETag = etag;
    headers["Last-Modified"] = new Date(lastModified).toUTCString();

    if (isFresh(request, etag, lastModified)) {
      // 304 carries no body, so the response is a few hundred bytes regardless
      // of how large the asset is.
      return new Response(null, { status: 304, headers });
    }
  }

  return new Response(file, { headers });
}

/**
 * Does the client already hold this exact version?
 *
 * `If-None-Match` wins outright when present: an entity tag is a stronger
 * statement than a timestamp, and mtime has only second-level resolution once
 * it has been through an HTTP date.
 */
export function requestMatchesEtag(request: Request, etag: string): boolean {
  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch === null) return false;

  return ifNoneMatch
    .split(",")
    .some((candidate) => candidate.trim() === etag || candidate.trim() === "*");
}

function isFresh(request: Request, etag: string, lastModified: number): boolean {
  if (request.headers.get("if-none-match") !== null) {
    return requestMatchesEtag(request, etag);
  }

  const ifModifiedSince = request.headers.get("if-modified-since");
  if (ifModifiedSince === null) return false;

  const since = Date.parse(ifModifiedSince);
  if (Number.isNaN(since)) return false;

  // HTTP dates lose sub-second precision, so compare at that resolution.
  return Math.floor(lastModified / 1000) * 1000 <= since;
}
