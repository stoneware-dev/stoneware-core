/**
 * File-based routing.
 *
 * Deriving patterns from filenames is delegated to `Bun.FileSystemRouter`: it
 * already implements exactly the Next.js-style conventions §7 calls for,
 * including `[slug]` and `[...rest]` (CLAUDE.md §2.6). Matching a request
 * against those patterns does not go through it - see route-table.ts for why.
 *
 * What this module adds on top is module loading and classification: a route
 * that default-exports a component renders HTML; one that exports HTTP method
 * handlers is a server action.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { compileRoutes, matchRoute } from "./route-table.ts";
import type { RouteIndex } from "./route-table.ts";
import type { Middleware, Locals } from "./middleware.ts";
import type { Child, Component, PageComponent } from "./types.ts";

/** `Bun.file().exists()` reports false for directories, so stat instead. */
export function directoryExists(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

export type HTTPMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

const HTTP_METHODS: HTTPMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** Arguments handed to a page template on every request. */
export interface PageProps {
  params: Record<string, string>;
  request: Request;
  url: URL;
  /** Anything `routes/_middleware.ts` put there for this request. */
  locals: Locals;
}

/** Arguments handed to a server action. */
export interface ActionContext {
  params: Record<string, string>;
  request: Request;
  url: URL;
  /** Anything `routes/_middleware.ts` put there for this request. */
  locals: Locals;
}

export type ActionHandler = (context: ActionContext) => Response | Promise<Response>;

export interface PageRoute {
  kind: "page";
  name: string;
  filePath: string;
  params: Record<string, string>;
  component: PageComponent<PageProps>;
  /** The module's optional `head` export (see `HeadFn`). */
  head?: HeadFn;
}

export interface ActionRoute {
  kind: "action";
  name: string;
  filePath: string;
  params: Record<string, string>;
  /** Handlers keyed by uppercase HTTP method. */
  handlers: Partial<Record<HTTPMethod, ActionHandler>>;
}

export type MatchedRoute = PageRoute | ActionRoute;

/** The error pages a project may define, by filename under `routes/`. */
export type ErrorPageName = "_404" | "_500";

/** Arguments handed to `routes/_404.tsx` and `routes/_500.tsx`. */
export interface ErrorPageProps extends PageProps {
  status: number;
  /** Short reason, already safe to display. */
  message: string;
  /**
   * The thrown value, in development only.
   *
   * Production leaves this undefined rather than trusting every error page not
   * to render it: an exception message routinely carries a file path, a query,
   * or a connection string.
   */
  error?: unknown;
}

/**
 * Is this route pattern reserved by the framework rather than servable?
 *
 * A leading underscore marks a file as a convention, not a page — the same
 * signal Next.js uses. Without this, `routes/_404.tsx` would answer a real
 * request at `/_404` with a 200, which is both surprising and a way to make the
 * error page reachable as content.
 */
export function isReservedRoute(pattern: string): boolean {
  return pattern.split("/").some((segment) => segment.startsWith("_"));
}

export interface RouterOptions {
  /** In dev, modules are re-imported on every request so edits take effect. */
  dev?: boolean;
  /**
   * Route modules already present in the running bundle, keyed by route
   * pattern.
   *
   * A production build inlines every route this way, so serving a request
   * involves no filesystem read and no transpilation.
   *
   * Keyed by pattern rather than by file path on purpose: a path is a property
   * of the machine that ran the build, and baking one into the bundle is what
   * made the output unservable anywhere else. A pattern is a property of the
   * project.
   */
  preloaded?: Map<string, Record<string, unknown>>;
  /**
   * A pre-built pattern table, mapping route pattern to module path.
   *
   * Supplied by a production build so the router never scans the filesystem.
   * With it, `routes/` need not exist at runtime at all - which is what lets a
   * built server run inside a serverless function or a scratch container.
   */
  manifest?: Record<string, string>;
}

export class Router {
  readonly routesDir: string;
  #table: Record<string, string> | null = null;
  #index: RouteIndex = { literals: new Map(), dynamic: [], all: [] };
  #dev: boolean;
  #preloaded: Map<string, Record<string, unknown>>;
  #manifest: Record<string, string> | undefined;

  constructor(routesDir: string, options: RouterOptions = {}) {
    this.routesDir = resolve(routesDir);
    this.#dev = options.dev ?? false;
    this.#preloaded = options.preloaded ?? new Map();
    this.#manifest = options.manifest;
  }

  /** Build (or rebuild) the route table. */
  async init(): Promise<void> {
    if (this.#manifest) {
      this.#setTable(this.#manifest);
      return;
    }

    if (!directoryExists(this.routesDir)) {
      throw new Error(
        `Routes directory not found: ${this.routesDir}\n` +
          `Create a routes/ directory with at least an index.tsx.`,
      );
    }

    this.#setTable(scanRoutes(this.routesDir));
  }

  /** Pick up files added or removed since the last scan. */
  reload(): void {
    if (this.#manifest) return;
    if (directoryExists(this.routesDir)) this.#setTable(scanRoutes(this.routesDir));
  }

  /** All known route patterns, for logging and diagnostics. */
  get routes(): Record<string, string> {
    return this.#table ?? {};
  }

  #setTable(table: Record<string, string>): void {
    this.#table = table;
    this.#index = compileRoutes(table);
  }

  async match(url: URL | string): Promise<MatchedRoute | null> {
    if (this.#table === null) {
      throw new Error("Router.init() must be awaited before matching requests.");
    }

    const pathname = typeof url === "string" ? url : url.pathname;

    const matched = matchRoute(this.#index, pathname);
    if (!matched) return null;
    if (isReservedRoute(matched.pattern)) return null;

    const { pattern, filePath, params } = matched;
    const module = await this.#import(pattern, filePath);

    const handlers = collectHandlers(module);
    if (Object.keys(handlers).length > 0) {
      return { kind: "action", name: pattern, filePath, params, handlers };
    }

    if (typeof module.default === "function") {
      return {
        kind: "page",
        name: pattern,
        filePath,
        params,
        component: module.default as PageComponent<PageProps>,
        head: typeof module.head === "function" ? (module.head as HeadFn) : undefined,
      };
    }

    throw new Error(
      `Route ${filePath} exports neither a default component nor any HTTP ` +
        `method handlers (${HTTP_METHODS.join(", ")}).`,
    );
  }

  /**
   * Load a custom error page, or null if the project has not defined one.
   *
   * These come through the ordinary route table, so a production build inlines
   * them into the server bundle like any other route and dev picks up edits to
   * them without a restart — neither needed a special case.
   */
  async errorPage(name: ErrorPageName): Promise<PageComponent<ErrorPageProps> | null> {
    const filePath = this.routes[`/${name}`];
    if (!filePath) return null;

    const module = await this.#import(`/${name}`, filePath);
    return typeof module.default === "function"
      ? (module.default as PageComponent<ErrorPageProps>)
      : null;
  }

  /**
   * The project's `routes/_middleware.ts`, or null if it has none.
   *
   * Loaded through the ordinary route table like the error pages, so a
   * production build inlines it and dev picks up edits without a restart.
   */
  async middleware(): Promise<Middleware | null> {
    const filePath = this.routes["/_middleware"];
    if (!filePath) return null;

    const module = await this.#import("/_middleware", filePath);
    return typeof module.default === "function" ? (module.default as Middleware) : null;
  }

  async #import(pattern: string, filePath: string): Promise<Record<string, unknown>> {
    const preloaded = this.#preloaded.get(pattern);
    if (preloaded) return preloaded;

    const href = Bun.pathToFileURL(filePath).href;
    // Bun caches modules by specifier; a changing query defeats that in dev so
    // edits are picked up without restarting the process.
    const specifier = this.#dev ? `${href}?v=${Date.now()}` : href;
    return (await import(specifier)) as Record<string, unknown>;
  }
}

/**
 * Derive the pattern table from `routes/`.
 *
 * `Bun.FileSystemRouter` is still what turns filenames into patterns - that part
 * is a convention worth borrowing rather than reimplementing. Only its `match()`
 * is left unused; see route-table.ts for why.
 */
export function scanRoutes(routesDir: string): Record<string, string> {
  const scanner = new Bun.FileSystemRouter({
    style: "nextjs",
    dir: routesDir,
    fileExtensions: [".tsx", ".jsx", ".ts", ".js"],
  });
  return { ...scanner.routes };
}

function collectHandlers(
  module: Record<string, unknown>,
): Partial<Record<HTTPMethod, ActionHandler>> {
  const handlers: Partial<Record<HTTPMethod, ActionHandler>> = {};
  for (const method of HTTP_METHODS) {
    const handler = module[method];
    if (typeof handler === "function") handlers[method] = handler as ActionHandler;
  }
  return handlers;
}

/**
 * A page may export `head` to contribute to `<head>` without owning the
 * document.
 *
 * ```tsx
 * export function head({ params }: PageProps) {
 *   return (
 *     <>
 *       <title>{params.slug}</title>
 *       <meta name="description" content="..." />
 *     </>
 *   );
 * }
 * ```
 *
 * It runs in the same render context as the page, so it may await data and call
 * the same helpers. Returning a `<title>` suppresses the default one rather
 * than producing two.
 */
export type HeadFn = (props: PageProps) => Child | Promise<Child>;
