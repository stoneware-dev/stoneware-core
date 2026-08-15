/**
 * The request pipeline.
 *
 * Order matters here and is the reason the security guarantees hold: CSRF
 * verification happens before any handler is reached, and the security headers
 * are applied on the way out to every HTML response rather than by each route
 * (CLAUDE.md §9, §10).
 */

import { join, resolve, sep } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import {
  CLIENT_ASSET_PREFIX,
  ISLAND_MANIFEST_FILE,
  STYLESHEET_MANIFEST_FILE,
  buildIslands,
  buildStyles,
} from "./build.ts";
import { SECURITY_HEADERS, resolveConfig } from "./config.ts";
import { buildDocument } from "./document.ts";
import { corsHeaders, preflightResponse } from "./cors.ts";
import { verifyRequest } from "./csrf.ts";
import { withRenderContext } from "./context.ts";
import { buildIslandRegistry, discoverIslands, loadIslands } from "./islands.ts";
import { renderToString } from "./render.ts";
import { Router } from "./router.ts";
import { isNotFound } from "./not-found.ts";
import { notify } from "./observe.ts";
import type { Locals } from "./middleware.ts";
import { listen } from "./listen.ts";
import { requestURL } from "./url.ts";
import type { RequestKind } from "./observe.ts";
import type { IslandManifest } from "./build.ts";
import type { StonewareConfig, ResolvedConfig } from "./config.ts";
import type { ActionRoute, HTTPMethod, PageRoute } from "./router.ts";
import type { Component } from "./types.ts";

export interface StonewareApp {
  config: ResolvedConfig;
  router: Router;
  islandManifest: IslandManifest;
  /** Handle one request. Usable directly in tests without opening a port. */
  fetch(request: Request): Promise<Response>;
  /**
   * Pick up changes on disk. Used by the dev watcher.
   *
   * With no argument everything is redone, which is what a caller with no idea
   * what changed should get. The watcher does know, and passes it on.
   */
  refresh(what?: RefreshOptions): Promise<void>;
}

/**
 * Which parts of a dev rebuild are actually needed.
 *
 * Every one of these was being done on every file change, so editing a template
 * re-bundled every island and re-emitted the stylesheet - work that cannot have
 * been invalidated by the edit. On a two-island fixture that was ~53ms added to
 * each save, and it grows with the number of islands.
 */
export interface RefreshOptions {
  /** Re-scan `routes/` for files added or removed. */
  routes?: boolean;
  /** Reload island modules and rebuild their client chunks. */
  islands?: boolean;
  /**
   * Rebuild the stylesheet.
   *
   * Implied by `islands`, and not optional when it is set: building the island
   * chunks clears the static directory, taking the stylesheet with it.
   */
  styles?: boolean;
}

export interface CreateAppOptions {
  dev?: boolean;
  /** Route modules inlined by a production build, keyed by route pattern. */
  preloadedRoutes?: Map<string, Record<string, unknown>>;
  /** Island components inlined by a production build, keyed by island name. */
  preloadedIslands?: Map<string, Component<any>>;
  /**
   * Pattern table from a production build. With it the router never reads
   * `routes/`, so the built server runs where the source tree does not exist.
   */
  routeManifest?: Record<string, string>;
  /**
   * The island manifest, inlined by a production build.
   *
   * Supplied so the server never reads `.stoneware/islands.json` off disk. That
   * read used a path computed at runtime, which a function bundler tracing
   * imports cannot follow, so the file was left behind and the server threw at
   * boot with the bundle otherwise intact.
   */
  islandManifest?: IslandManifest;
  /** Hashed stylesheet URL, inlined by the same build for the same reason. */
  stylesheet?: string | null;
  /**
   * Extra markup injected before `</body>` on every HTML page. The dev server
   * uses this for its live-reload client; production never sets it.
   */
  documentSuffix?: string;
  /**
   * Embed the Content-Security-Policy as `<meta http-equiv>` in every page.
   *
   * Set only by `stoneware export`. A running server sends the policy as a
   * header, which is strictly better - it covers `frame-ancestors`, which a meta
   * tag cannot. Static files carry no headers at all, so for an export the
   * choice is a partial policy or none.
   */
  embedCSPMeta?: boolean;
}

/**
 * What the pipeline learned about a request while answering it.
 *
 * Mutable and threaded through by hand rather than carried in async storage:
 * the pipeline is three functions deep, and a parameter is both cheaper and
 * easier to follow than a second `AsyncLocalStorage` for two fields.
 */
interface Trace {
  kind: RequestKind;
  route: string | null;
}

export async function createApp(
  userConfig: StonewareConfig = {},
  options: CreateAppOptions = {},
): Promise<StonewareApp> {
  const dev = options.dev ?? false;
  const config = resolveConfig(userConfig, dev);

  const router = new Router(config.routesDir, {
    dev,
    preloaded: options.preloadedRoutes,
    manifest: options.routeManifest,
  });
  await router.init();

  let islandRegistry = new Map<Component<any>, string>();
  let islandManifest: IslandManifest = {};
  let stylesheet: string | null = null;
  let staticDir = join(config.outDir, "static");

  async function rebuildIslands(): Promise<void> {
    // The registry maps component identity to island name, so it is needed
    // whether or not the client bundles have to be rebuilt.
    //
    // A production build hands the components over directly, and that is the
    // only source consulted when it does. Re-deriving the list from `islands/`
    // would make a built server depend on the source tree it was built from
    // still sitting beside it — which it does not inside a function bundle or a
    // relocated container image. The failure mode was silent in the worst way:
    // pages rendered, every island fell back to plain markup, and nothing was
    // logged because an empty registry is indistinguishable from a page that
    // legitimately has no islands.
    islandRegistry = new Map();
    if (options.preloadedIslands) {
      for (const [name, component] of options.preloadedIslands) {
        islandRegistry.set(component, name);
      }
    }

    // Only scan when something actually needs the files: dev rebuilds chunks
    // from them, and an app created without a build has no other source.
    const entries =
      dev || !options.preloadedIslands ? await discoverIslands(config.islandsDir) : [];

    if (!options.preloadedIslands) {
      islandRegistry = buildIslandRegistry(await loadIslands(entries));
    }

    // Handed over by the build, so there is no file to lose in transit.
    //
    // This is the difference between a bundle that deploys and one that does
    // not. Reading the manifest from disk means computing its path at runtime,
    // and a path computed at runtime is invisible to a platform that builds a
    // function by tracing imports: the bundle arrives, `islands.json` does not,
    // and the server throws before its first request. Vercel failed exactly
    // that way.
    if (!dev && options.islandManifest) {
      islandManifest = options.islandManifest;
      staticDir = join(config.outDir, "static");
      stylesheet = options.stylesheet ?? null;
      warnIfNothingRegistered(islandManifest, islandRegistry);
      return;
    }

    // A production build already emitted the chunks and the manifest; rebuilding
    // them at boot would be wasted work and would change hashed filenames.
    const manifestPath = join(config.outDir, ISLAND_MANIFEST_FILE);
    if (!dev) {
      if (await Bun.file(manifestPath).exists()) {
        islandManifest = (await Bun.file(manifestPath).json()) as IslandManifest;
        staticDir = join(config.outDir, "static");

        warnIfNothingRegistered(islandManifest, islandRegistry);

        const stylesRef = Bun.file(join(config.outDir, STYLESHEET_MANIFEST_FILE));
        stylesheet = (await stylesRef.exists()) ? (await stylesRef.text()).trim() || null : null;
        return;
      }

      // Never rebuild in production. Falling through to buildIslands() would
      // write to disk, and a serverless filesystem is read-only outside /tmp —
      // producing an EROFS crash that reads as unrelated to the real cause.
      // Even where the write succeeds, the emitted chunks would be missing from
      // whatever was deployed, so the pages would reference files that are not
      // there. Failing here names the actual problem.
      throw new Error(
        `Island manifest not found at ${manifestPath}.\n` +
          `Run \`stoneware build\` before starting the server. If this is a deploy, the ` +
          `build output did not reach the runtime — check that ${config.outDir} is included ` +
          `in what was deployed.`,
      );
    }

    const built = await buildIslands({ islands: entries, outDir: config.outDir, dev });
    islandManifest = built.manifest;
    staticDir = built.staticDir;

    // After the islands, never before: buildIslands clears the static directory,
    // which would take the stylesheet with it.
    await rebuildStyles();
  }

  async function rebuildStyles(): Promise<void> {
    stylesheet = await buildStyles({
      dirs: [config.routesDir, config.islandsDir, join(config.root, "lib")],
      outDir: config.outDir,
      dev,
    });
  }

  await rebuildIslands();

  const app: StonewareApp = {
    config,
    router,
    get islandManifest() {
      return islandManifest;
    },
    async refresh(what?: RefreshOptions) {
      // No argument means "something changed and I do not know what", so
      // everything is redone. An argument - even a partial one - is a claim
      // about what changed, and anything it does not name is left alone. The
      // two must not be conflated: defaulting each missing field to true would
      // make `{ routes: true }` rebuild the islands as well, which is exactly
      // the behaviour this exists to avoid.
      const everything = what === undefined;
      const routes = everything || what.routes === true;
      const islands = everything || what.islands === true;
      // Never independent of `islands`: rebuilding the chunks clears the static
      // directory, so a skipped stylesheet would simply be gone.
      const styles = islands || what?.styles === true;

      if (routes) router.reload();
      if (islands) await rebuildIslands();
      else if (styles) await rebuildStyles();
    },
    async fetch(request: Request): Promise<Response> {
      // The public URL, not the internal one. Behind a TLS-terminating proxy the
      // two differ in scheme, and every absolute URL a page builds comes from
      // here. Resolved once, at the top, so the observer describes the same URL
      // the route was handed rather than parsing it a second time.
      const url = requestURL(request, config.trustProxy);

      // Read once: nothing reassigns it, and it decides whether this request
      // pays for timing at all. With no observer configured there is nobody to
      // report a duration to, so the clock is never read.
      const observer = config.observe;
      const started = observer === null ? 0 : performance.now();

      // Filled in as the request travels: what answered it, and which pattern.
      // "not-found" is the honest starting value - it is what a request gets if
      // nothing downstream claims it.
      const trace: Trace = { kind: "not-found", route: null };

      // Every response leaves through this one point, so a new code path cannot
      // forget the security headers.
      //
      // A route that sets one of these headers itself keeps its own value -
      // `withSecurityHeaders` fills gaps rather than overwriting, which is what
      // makes a per-route CSP possible. That is a deliberate escape hatch, not
      // an accident: forgetting a header is impossible, replacing one is not.
      let response: Response;
      let thrown: unknown;

      try {
        response = withCORS(
          withSecurityHeaders(await handleRequest(request, url, trace), config),
          request,
          config,
        );
      } catch (error) {
        // `notFound()` from anywhere the page render did not already catch it -
        // an action handler, or a helper called outside the render. It is a
        // deliberate answer, not a failure, so it is not logged as one.
        if (isNotFound(error)) {
          trace.kind = "not-found";
          response = withSecurityHeaders(
            await renderErrorPage(404, error.message, request),
            config,
          );
        } else {
          trace.kind = "error";
          thrown = error;
          console.error("[stoneware] Unhandled error while serving request:", error);
          // renderErrorPage never throws, so this catch cannot be re-entered.
          response = withSecurityHeaders(
            await renderErrorPage(500, "Internal Server Error", request, error),
            config,
          );
        }
      }

      // After the response is fully assembled, including the security headers,
      // so the status reported is the status sent. `notify` swallows whatever
      // the observer does wrong; nothing here can change the response.
      if (observer !== null) {
        notify(observer, {
          request,
          url,
          method: request.method,
          kind: trace.kind,
          route: trace.route,
          status: response.status,
          durationMs: performance.now() - started,
          error: thrown,
        });
      }

      return response;
    },
  };

  async function handleRequest(request: Request, url: URL, trace: Trace): Promise<Response> {
    // Built client chunks.
    if (url.pathname.startsWith(`${CLIENT_ASSET_PREFIX}/`)) {
      trace.kind = "asset";
      return serveStatic(
        staticDir,
        url.pathname.slice(CLIENT_ASSET_PREFIX.length + 1),
        dev,
        config.followSymlinks,
      );
    }

    // Anything in public/ is served as-is.
    const asset = await serveStaticIfExists(
      request,
      config.publicDir,
      url.pathname,
      dev,
      config.followSymlinks,
    );
    if (asset) {
      trace.kind = "asset";
      return asset;
    }

    // A preflight is answered before verification, and only ever before it: the
    // browser sends OPTIONS with no body and no token by design, and refuses to
    // send the real request until this succeeds. It changes nothing on the
    // server, so there is nothing for CSRF to protect here.
    if (config.cors) {
      const preflight = preflightResponse(request, config.cors);
      if (preflight) {
        trace.kind = "preflight";
        return preflight;
      }
    }

    // Every mutating request is verified before anything else observes it -
    // before middleware, before the route, before any handler. There is no
    // per-route opt-in and nothing a project can put in front of it.
    const csrf = await verifyRequest(request, config);
    if (!csrf.ok) {
      // Reported apart from an application error on purpose. A rise in these is
      // a security signal - a stale form, a misconfigured proxy, or someone
      // trying - and averaging them into the 5xx rate hides all three.
      trace.kind = "rejected";
      return errorResponse(403, csrf.reason ?? "Forbidden", config, undefined, request);
    }

    // Middleware runs after verification and before matching, so it also sees
    // requests that are about to 404 - a redirect rule for a moved page is
    // worth nothing if it only runs for paths that already resolve.
    const locals = {} as Locals;
    const middleware = await router.middleware();
    if (middleware) {
      const short = await middleware({ request, url, locals });
      if (short instanceof Response) {
        trace.kind = "middleware";
        return short;
      }
    }

    const route = await router.match(url);
    if (!route) return renderErrorPage(404, "Not Found", request);

    // The pattern, not the path. `/blog/[slug]` is one row on a dashboard;
    // `/blog/hello-world` is one row per post.
    trace.kind = route.kind === "action" ? "action" : "page";
    trace.route = route.name;

    return route.kind === "action"
      ? handleAction(route, request, url, locals)
      : handlePage(route, request, url, locals);
  }

  async function handleAction(
    route: ActionRoute,
    request: Request,
    url: URL,
    locals: Locals,
  ): Promise<Response> {
    const method = await resolveMethod(request);
    const handler = route.handlers[method] ?? (method === "HEAD" ? route.handlers.GET : undefined);

    if (!handler) {
      const allowed = Object.keys(route.handlers).join(", ");
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: allowed } });
    }

    return await handler({ params: route.params, request, url, locals });
  }

  async function handlePage(
    route: PageRoute,
    request: Request,
    url: URL,
    locals: Locals,
  ): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const props = { params: route.params, request, url, locals };

    // The page function runs inside the render context too, not just the
    // renderer: a template may call `csrfToken()` while building its tree, and
    // may await data before returning it.
    const context = {
      config,
      request,
      url,
      personalized: false,
      preloads: new Set<string>(),
      renderingHead: false,
      seoOutsideHead: false,
    };

    let rendered;
    try {
      rendered = await withRenderContext(context, async () => {
        const tree = await route.component(props);
        const body = renderToString(tree, { islands: islandRegistry });

        // `head` runs after the body, not before, so a preload contributed by an
        // <Image> deep in the page is already collected by the time the document
        // is assembled. It shares the render context either way.
        context.renderingHead = true;
        const head = route.head ? renderToString(await route.head(props)).html : "";
        context.renderingHead = false;
        return { body, head };
      });
    } catch (error) {
      // A route that matched but found no content. Answering 404 here rather
      // than rendering "no such page" with a 200 is the whole point: a soft 404
      // gets indexed, and tells a client the request succeeded.
      if (isNotFound(error)) return renderErrorPage(404, error.message, request);
      throw error;
    }

    const html = buildDocument({
      html: rendered.body.html,
      islands: rendered.body.islands,
      manifest: islandManifest,
      title: route.name === "/" ? "Home" : route.name.replace(/^\//, ""),
      suffix: options.documentSuffix,
      stylesheet,
      head: rendered.head,
      preloads: [...context.preloads],
      cspMeta: options.embedCSPMeta && config.csp !== false ? config.csp : null,
    });

    warnIfSEOStranded(context.seoOutsideHead, rendered.body.html, route.name, dev);

    const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });

    if (dev) {
      headers.set("Cache-Control", "no-store");
    } else if (context.personalized) {
      // The markup embeds a CSRF token, so it belongs to one visitor. A shared
      // cache must never hold it, and there is nothing to revalidate against
      // either: a fresh token on every render means the body changes each time.
      headers.set("Cache-Control", "private, no-store");
    } else {
      // Identical for every visitor. `no-cache` means "revalidate", not "do not
      // store", so a CDN or browser keeps the bytes and a repeat request costs
      // one 304 rather than a re-render.
      headers.set("Cache-Control", "public, no-cache");
      headers.set("ETag", `W/"${Bun.hash(html).toString(16)}"`);
    }

    const etag = headers.get("ETag");
    if (etag !== null && requestMatchesEtag(request, etag)) {
      return new Response(null, { status: 304, headers });
    }

    return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
  }

  /**
   * Render `routes/_404.tsx` or `routes/_500.tsx`, falling back to a built-in
   * page when the project has none — or when the project's own error page
   * throws.
   *
   * That fallback is the whole reason this is separate from `handlePage`. An
   * error page that fails is the one case where re-entering the normal error
   * path would recurse forever, so failure here is terminal: it logs and serves
   * markup that cannot fail.
   */
  async function renderErrorPage(
    status: 404 | 500,
    message: string,
    request: Request,
    error?: unknown,
  ): Promise<Response> {
    const name = status === 404 ? "_404" : "_500";

    // A JSON client gets JSON, custom error page or not. Rendering the page
    // would hand a fetch() a document to parse.
    if (prefersJSON(request)) {
      return errorResponse(status, message, config, dev ? error : undefined, request);
    }

    try {
      const component = await router.errorPage(name);
      if (component) {
        const url = requestURL(request, config.trustProxy);
        const props = {
          status,
          message,
          params: {},
          request,
          url,
          locals: {} as Locals,
          // Only in dev. An exception message routinely carries a file path or
          // a query, and this would hand it to whatever the page renders.
          error: dev ? error : undefined,
        };

        const context = {
          config,
          request,
          url,
          personalized: false,
          preloads: new Set<string>(),
          renderingHead: false,
          seoOutsideHead: false,
        };
        const rendered = await withRenderContext(context, async () => {
          const tree = await component(props);
          return renderToString(tree, { islands: islandRegistry });
        });

        const html = buildDocument({
          preloads: [...context.preloads],
          html: rendered.html,
          islands: rendered.islands,
          manifest: islandManifest,
          title: String(status),
          suffix: options.documentSuffix,
          stylesheet,
          cspMeta: options.embedCSPMeta && config.csp !== false ? config.csp : null,
        });

        return htmlResponse(html, status, request);
      }
    } catch (pageError) {
      console.error(`[stoneware] routes/${name} failed to render:`, pageError);
    }

    return errorResponse(status, message, config, dev ? error : undefined, request);
  }

  return app;
}

/**
 * An error response is never cached.
 *
 * `no-cache` would be safe for the body but not for the situation: a 404 held
 * by a CDN outlives the deploy that adds the missing page, and a 500 captured
 * during an incident outlives the fix.
 */
function htmlResponse(html: string, status: number, request: Request): Response {
  return new Response(request.method === "HEAD" ? null : html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * HTML forms can only send GET and POST, so `<Form method="DELETE">` submits a
 * POST carrying a `_method` field. The override is read only after CSRF
 * verification has already passed, so it cannot be used to reach a handler
 * unauthenticated.
 */
async function resolveMethod(request: Request): Promise<HTTPMethod> {
  const method = request.method.toUpperCase() as HTTPMethod;
  if (method !== "POST") return method;

  const contentType = request.headers.get("content-type") ?? "";
  if (
    !contentType.includes("application/x-www-form-urlencoded") &&
    !contentType.includes("multipart/form-data")
  ) {
    return method;
  }

  try {
    const body = await request.clone().formData();
    const override = body.get("_method");
    if (typeof override === "string") {
      const upper = override.toUpperCase();
      if (upper === "PUT" || upper === "PATCH" || upper === "DELETE") return upper;
    }
  } catch {
    // Not form-encoded after all; fall through to the real method.
  }
  return method;
}

/* -------------------------------------------------------------------------- */
/* Static files                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a URL path inside a directory, refusing anything that escapes it.
 *
 * Returns `null` for traversal attempts rather than throwing, so the caller
 * treats them as ordinary 404s and leaks nothing about the layout on disk.
 */
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

async function serveStatic(
  rootDir: string,
  relativePath: string,
  dev: boolean,
  followSymlinks: boolean,
): Promise<Response> {
  const target = safeJoin(rootDir, relativePath, followSymlinks);
  if (!target) return new Response("Not Found", { status: 404 });

  const file = Bun.file(target);
  if (!(await file.exists())) return new Response("Not Found", { status: 404 });

  return new Response(file, {
    headers: {
      // Client chunks carry a content hash in their filename, so they are
      // immutable by construction - but only once they stop changing per build.
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
async function serveStaticIfExists(
  request: Request,
  rootDir: string,
  pathname: string,
  dev: boolean,
  followSymlinks: boolean,
): Promise<Response | null> {
  if (pathname === "/" || pathname.endsWith("/")) return null;

  const target = safeJoin(rootDir, pathname, followSymlinks);
  if (!target) return null;

  const file = Bun.file(target);
  if (!(await file.exists())) return null;

  const headers: Record<string, string> = {
    "Cache-Control": dev ? "no-store" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  };

  if (!dev) {
    const etag = `W/"${file.size.toString(16)}-${file.lastModified.toString(16)}"`;
    headers.ETag = etag;
    headers["Last-Modified"] = new Date(file.lastModified).toUTCString();

    if (isFresh(request, etag, file.lastModified)) {
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

/* -------------------------------------------------------------------------- */
/* Responses                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Apply the security headers to a response, without touching its body.
 *
 * Mutating the existing `Headers` matters for static files: re-wrapping a
 * `Bun.file()` response in a new `Response` would give up Bun's direct
 * file-serving path and stream the bytes through userland instead.
 *
 * A response that came from `fetch()` has immutable headers; those are copied.
 */
function withSecurityHeaders(response: Response, config: ResolvedConfig): Response {
  const apply = (headers: Headers) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    if (config.csp !== false && !headers.has("Content-Security-Policy")) {
      headers.set("Content-Security-Policy", config.csp);
    }
  };

  try {
    apply(response.headers);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    apply(headers);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

/**
 * The built-in error page, used when a project defines no `_404`/`_500`.
 *
 * In development it shows the thrown error and its stack. Without this the
 * fallback said only "Internal Server Error", and the one piece of information
 * the developer needed was in the terminal instead of in front of them.
 *
 * Unstyled on purpose: the default `style-src 'self'` forbids an inline
 * `<style>` block, and relaxing the policy to prettify an error page would mean
 * developing against a policy production does not use.
 */
/**
 * Attach the cross-origin headers, if the project enabled them.
 *
 * At the same single exit as the security headers, for the same reason: a route
 * cannot forget them, and a new code path cannot skip them.
 */
function withCORS(response: Response, request: Request, config: ResolvedConfig): Response {
  if (!config.cors) return response;

  const headers = corsHeaders(request, config.cors);
  if (headers === null) return response;

  for (const [name, value] of headers) response.headers.append(name, value);
  return response;
}

function errorResponse(
  status: number,
  message: string,
  _config: ResolvedConfig,
  error?: unknown,
  request?: Request,
): Response {
  // An API client asked for JSON and should not be handed a page of markup to
  // parse. Without this a fetch() against a failing route resolves with
  // `<!DOCTYPE html>` in the body and no usable error.
  if (request !== undefined && prefersJSON(request)) {
    return jsonError(status, message, error);
  }

  const body =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${status}</title></head><body><h1>${status}</h1>` +
    `<p>${Bun.escapeHTML(message)}</p>` +
    renderErrorDetail(error) +
    `</body></html>`;

  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * Does this client want JSON rather than a page?
 *
 * Read from `Accept` rather than from the path: a route under `routes/api/`
 * that a browser navigates to should still render the error page, and a
 * `fetch()` at any path should get JSON. The header is what actually states
 * the caller's intent.
 */
/**
 * `seo()` in the page body, on a page that does not own its own document.
 *
 * Those tags end up in `<body>`, where nothing reads them. A page that returns
 * a whole `<html>` is a different matter - it may legitimately call `seo()`
 * inside its own `<head>` - so the check needs both facts, which is why it
 * happens here rather than at the call site.
 */
function warnIfSEOStranded(
  calledOutsideHead: boolean,
  html: string,
  route: string,
  dev: boolean,
): void {
  if (!dev || !calledOutsideHead) return;
  if (/^\s*(<!DOCTYPE[^>]*>\s*)?<html[\s>]/i.test(html)) return;

  console.warn(
    `[stoneware] seo() was called while rendering ${route}, not from its head export.
` +
      `  Those tags land in <body>, where nothing reads them. Move the call into:
` +
      `    export function head(props) { return seo({ ... }); }`,
  );
}

function prefersJSON(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json")) return true;

  // A bare `fetch()` sends `*/*`, which says nothing. Treat it as JSON only
  // when the request could not have come from a document navigation.
  const mode = request.headers.get("sec-fetch-mode");
  const dest = request.headers.get("sec-fetch-dest");
  if (mode === "cors" || dest === "empty") return !accept.includes("text/html");

  return false;
}

function jsonError(status: number, message: string, error?: unknown): Response {
  const body: Record<string, unknown> = { error: message, status };

  // Development only - the caller passes `undefined` in production, so no
  // stack reaches a client.
  if (error !== undefined) {
    body.detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (error instanceof Error && error.stack) body.stack = error.stack;
  }

  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Render a thrown value for the dev error page.
 *
 * Only ever called with an error in development - the caller passes `undefined`
 * in production, so there is no path by which a stack reaches a visitor.
 */
function renderErrorDetail(error: unknown): string {
  if (error === undefined) return "";

  const detail =
    error instanceof Error
      ? `${error.name}: ${error.message}\n\n${error.stack ?? "(no stack)"}`
      : String(error);

  return `<h2>Error</h2><pre>${Bun.escapeHTML(detail)}</pre>`;
}

/* -------------------------------------------------------------------------- */
/* Serving                                                                     */
/* -------------------------------------------------------------------------- */

export interface ServeResult {
  app: StonewareApp;
  /**
   * Derived from `Bun.serve` rather than written out, so it tracks Bun's
   * signature. (`Bun.Server` takes a mandatory type parameter for WebSocket
   * data; this server configures no `websocket` handler, so there is none.)
   */
  server: ReturnType<typeof Bun.serve>;
}

export async function serve(
  userConfig: StonewareConfig = {},
  options: CreateAppOptions = {},
): Promise<ServeResult> {
  const app = await createApp(userConfig, options);

  const server = await listen({
    // No fallback here on purpose: a platform routes traffic to the port it
    // assigned, so binding a different one yields a service that looks healthy
    // in its own logs while every external request fails.
    port: app.config.port,
    hostname: app.config.hostname,
    fetch: (request) => app.fetch(request),
  });

  return { app, server };
}

/**
 * Built islands that nothing can hydrate.
 *
 * The manifest names islands the build produced chunks for; the registry is what
 * lets a render recognise one. If the second is empty while the first is not,
 * every island on every page renders as inert markup - correct-looking HTML
 * that ships no JavaScript.
 *
 * This shipped once, and it went unnoticed because an empty registry is
 * indistinguishable from a page that legitimately has no islands: no error, no
 * warning, nothing in the network tab. Saying so out loud costs one comparison
 * at boot.
 */
function warnIfNothingRegistered(
  manifest: IslandManifest,
  registry: Map<Component<any>, string>,
): void {
  const named = Object.keys(manifest).filter((name) => !name.startsWith("@"));
  if (named.length === 0 || registry.size > 0) return;

  console.error(
    `[stoneware] ${named.length} island(s) were built but none are registered, ` +
      `so none will hydrate.\n` +
      `  Built: ${named.join(", ")}\n` +
      `  Pages will render their markup and ship no JavaScript for them. ` +
      `This means the running server did not receive the island components ` +
      `the build inlined — check that .stoneware/server.js is what is being run.`,
  );
}
