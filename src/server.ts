/**
 * The request pipeline.
 *
 * Order matters here and is the reason the security guarantees hold: CSRF
 * verification happens before any handler is reached, and the security headers
 * are applied on the way out to every HTML response rather than by each route
 * (CLAUDE.md §9, §10).
 */

import { join, resolve, sep } from "node:path";
import { CLIENT_ASSET_PREFIX, ISLAND_MANIFEST_FILE, buildIslands } from "./build.ts";
import { SECURITY_HEADERS, resolveConfig } from "./config.ts";
import { buildDocument } from "./document.ts";
import { verifyRequest } from "./csrf.ts";
import { withRenderContext } from "./context.ts";
import { buildIslandRegistry, discoverIslands, loadIslands } from "./islands.ts";
import { renderToString } from "./render.ts";
import { Router } from "./router.ts";
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
  /** Rebuild islands and re-scan routes. Used by the dev watcher. */
  refresh(): Promise<void>;
}

export interface CreateAppOptions {
  dev?: boolean;
  /** Route modules inlined by a production build, keyed by absolute path. */
  preloadedRoutes?: Map<string, Record<string, unknown>>;
  /** Island components inlined by a production build, keyed by island name. */
  preloadedIslands?: Map<string, Component<any>>;
  /**
   * Extra markup injected before `</body>` on every HTML page. The dev server
   * uses this for its live-reload client; production never sets it.
   */
  documentSuffix?: string;
}

export async function createApp(
  userConfig: StonewareConfig = {},
  options: CreateAppOptions = {},
): Promise<StonewareApp> {
  const dev = options.dev ?? false;
  const config = resolveConfig(userConfig, dev);

  const router = new Router(config.routesDir, { dev, preloaded: options.preloadedRoutes });
  await router.init();

  let islandRegistry = new Map<Component<any>, string>();
  let islandManifest: IslandManifest = {};
  let staticDir = join(config.outDir, "static");

  async function rebuildIslands(): Promise<void> {
    const entries = await discoverIslands(config.islandsDir);

    // The registry maps component identity to island name, so it is needed
    // whether or not the client bundles have to be rebuilt.
    islandRegistry = new Map();
    if (options.preloadedIslands) {
      for (const entry of entries) {
        const component = options.preloadedIslands.get(entry.name);
        if (component) islandRegistry.set(component, entry.name);
      }
    } else {
      islandRegistry = buildIslandRegistry(await loadIslands(entries));
    }

    // A production build already emitted the chunks and the manifest; rebuilding
    // them at boot would be wasted work and would change hashed filenames.
    const manifestPath = join(config.outDir, ISLAND_MANIFEST_FILE);
    if (!dev) {
      if (await Bun.file(manifestPath).exists()) {
        islandManifest = (await Bun.file(manifestPath).json()) as IslandManifest;
        staticDir = join(config.outDir, "static");
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
  }

  await rebuildIslands();

  const app: StonewareApp = {
    config,
    router,
    get islandManifest() {
      return islandManifest;
    },
    async refresh() {
      router.reload();
      await rebuildIslands();
    },
    async fetch(request: Request): Promise<Response> {
      // Every response leaves through this one point, and every response gets
      // the security headers here. Routes cannot opt out by constructing their
      // own Response, and a new code path cannot forget to add them.
      try {
        return withSecurityHeaders(await handleRequest(request), config);
      } catch (error) {
        console.error("[stoneware] Unhandled error while serving request:", error);
        return withSecurityHeaders(
          errorResponse(500, dev ? String(error) : "Internal Server Error", config),
          config,
        );
      }
    },
  };

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Built client chunks.
    if (url.pathname.startsWith(`${CLIENT_ASSET_PREFIX}/`)) {
      return serveStatic(staticDir, url.pathname.slice(CLIENT_ASSET_PREFIX.length + 1), dev);
    }

    // Anything in public/ is served as-is.
    const asset = await serveStaticIfExists(config.publicDir, url.pathname, dev);
    if (asset) return asset;

    const route = await router.match(url);
    if (!route) return errorResponse(404, "Not Found", config);

    // Every mutating request is verified before a handler can observe it.
    // There is no per-route opt-in and no way to reach a handler without this.
    const csrf = await verifyRequest(request, config);
    if (!csrf.ok) {
      return errorResponse(403, csrf.reason ?? "Forbidden", config);
    }

    return route.kind === "action"
      ? handleAction(route, request, url)
      : handlePage(route, request, url);
  }

  async function handleAction(route: ActionRoute, request: Request, url: URL): Promise<Response> {
    const method = await resolveMethod(request);
    const handler = route.handlers[method] ?? (method === "HEAD" ? route.handlers.GET : undefined);

    if (!handler) {
      const allowed = Object.keys(route.handlers).join(", ");
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: allowed } });
    }

    return await handler({ params: route.params, request, url });
  }

  async function handlePage(route: PageRoute, request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const props = { params: route.params, request, url };

    // The page function runs inside the render context too, not just the
    // renderer: a template may call `csrfToken()` while building its tree, and
    // may await data before returning it.
    const rendered = await withRenderContext({ config, request, url }, async () => {
      const tree = await route.component(props);
      return renderToString(tree, { islands: islandRegistry });
    });

    const html = buildDocument({
      html: rendered.html,
      islands: rendered.islands,
      manifest: islandManifest,
      title: route.name === "/" ? "Home" : route.name.replace(/^\//, ""),
      suffix: options.documentSuffix,
    });

    return new Response(request.method === "HEAD" ? null : html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return app;
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
function safeJoin(rootDir: string, relativePath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    return null;
  }

  if (decoded.includes("\0")) return null;

  const root = resolve(rootDir);
  const target = resolve(root, "." + (decoded.startsWith("/") ? decoded : `/${decoded}`));

  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

async function serveStatic(rootDir: string, relativePath: string, dev: boolean): Promise<Response> {
  const target = safeJoin(rootDir, relativePath);
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

async function serveStaticIfExists(
  rootDir: string,
  pathname: string,
  dev: boolean,
): Promise<Response | null> {
  if (pathname === "/" || pathname.endsWith("/")) return null;

  const target = safeJoin(rootDir, pathname);
  if (!target) return null;

  const file = Bun.file(target);
  if (!(await file.exists())) return null;

  return new Response(file, {
    headers: {
      "Cache-Control": dev ? "no-store" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
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

function errorResponse(status: number, message: string, _config: ResolvedConfig): Response {
  const body =
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<title>${status}</title></head><body><h1>${status}</h1>` +
    `<p>${Bun.escapeHTML(message)}</p></body></html>`;

  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
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

  const server = Bun.serve({
    port: app.config.port,
    hostname: app.config.hostname,
    fetch: (request) => app.fetch(request),
  });

  return { app, server };
}
