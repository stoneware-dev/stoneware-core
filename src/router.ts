/**
 * File-based routing.
 *
 * Path-to-route resolution is delegated to `Bun.FileSystemRouter` rather than
 * reimplemented - it already implements exactly the Next.js-style conventions
 * §7 calls for, including `[slug]` and `[...rest]` (CLAUDE.md §2.6).
 *
 * What this module adds on top is module loading and classification: a route
 * that default-exports a component renders HTML; one that exports HTTP method
 * handlers is a server action.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Child, Component } from "./types.ts";

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
}

/** Arguments handed to a server action. */
export interface ActionContext {
  params: Record<string, string>;
  request: Request;
  url: URL;
}

export type ActionHandler = (context: ActionContext) => Response | Promise<Response>;

export interface PageRoute {
  kind: "page";
  name: string;
  filePath: string;
  params: Record<string, string>;
  component: Component<PageProps>;
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
   * Route modules already present in the running bundle, keyed by absolute
   * source path.
   *
   * A production build inlines every route this way, so serving a request
   * involves no filesystem read and no transpilation. Path *matching* still
   * comes from `Bun.FileSystemRouter`, so `routes/` must exist at runtime.
   */
  preloaded?: Map<string, Record<string, unknown>>;
}

export class Router {
  readonly routesDir: string;
  #router: Bun.FileSystemRouter | null = null;
  #dev: boolean;
  #preloaded: Map<string, Record<string, unknown>>;

  constructor(routesDir: string, options: RouterOptions = {}) {
    this.routesDir = resolve(routesDir);
    this.#dev = options.dev ?? false;
    this.#preloaded = options.preloaded ?? new Map();
  }

  /** Build (or rebuild) the route table from disk. */
  async init(): Promise<void> {
    if (!directoryExists(this.routesDir)) {
      throw new Error(
        `Routes directory not found: ${this.routesDir}\n` +
          `Create a routes/ directory with at least an index.tsx.`,
      );
    }
    this.#router = new Bun.FileSystemRouter({
      style: "nextjs",
      dir: this.routesDir,
      fileExtensions: [".tsx", ".jsx", ".ts", ".js"],
    });
  }

  /** Pick up files added or removed since the last scan. */
  reload(): void {
    this.#router?.reload();
  }

  /** All known route patterns, for logging and diagnostics. */
  get routes(): Record<string, string> {
    return this.#router?.routes ?? {};
  }

  async match(url: URL | string): Promise<MatchedRoute | null> {
    if (this.#router === null) {
      throw new Error("Router.init() must be awaited before matching requests.");
    }

    const pathname = typeof url === "string" ? url : url.pathname;

    const lookup = toMatchablePath(pathname);
    if (lookup === null) return null;

    const matched = this.#router.match(lookup);
    if (!matched) return null;
    if (isReservedRoute(matched.name)) return null;

    const params = restoreParams(matched.params);
    if (params === null) return null;

    const module = await this.#import(matched.filePath);

    const handlers = collectHandlers(module);
    if (Object.keys(handlers).length > 0) {
      return { kind: "action", name: matched.name, filePath: matched.filePath, params, handlers };
    }

    if (typeof module.default === "function") {
      return {
        kind: "page",
        name: matched.name,
        filePath: matched.filePath,
        params,
        component: module.default as Component<PageProps>,
        head: typeof module.head === "function" ? (module.head as HeadFn) : undefined,
      };
    }

    throw new Error(
      `Route ${matched.filePath} exports neither a default component nor any HTTP ` +
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
  async errorPage(name: ErrorPageName): Promise<Component<ErrorPageProps> | null> {
    const filePath = this.#router?.routes[`/${name}`];
    if (!filePath) return null;

    const module = await this.#import(filePath);
    return typeof module.default === "function"
      ? (module.default as Component<ErrorPageProps>)
      : null;
  }

  async #import(filePath: string): Promise<Record<string, unknown>> {
    const preloaded = this.#preloaded.get(resolve(filePath));
    if (preloaded) return preloaded;

    const href = Bun.pathToFileURL(filePath).href;
    // Bun caches modules by specifier; a changing query defeats that in dev so
    // edits are picked up without restarting the process.
    const specifier = this.#dev ? `${href}?v=${Date.now()}` : href;
    return (await import(specifier)) as Record<string, unknown>;
  }
}

/**
 * Stand-in for "%" while Bun does the matching.
 *
 * U+FFFF is a permanent noncharacter: it is never legal in a URL and carries no
 * meaning in a path, so it cannot collide with real content. Any that somehow
 * arrives in a request is stripped before the substitution, so the mapping back
 * is unambiguous.
 */
const PERCENT_SENTINEL = "￿";

/**
 * Prepare a request path for `Bun.FileSystemRouter.match()`.
 *
 * Bun 1.3.14 aborts the process - a native panic, not a catchable exception -
 * when the path it is given contains "%". That includes well-formed escapes
 * such as "%41" and applies to static routes as much as dynamic ones. Since the
 * path of an incoming request is entirely attacker-controlled, handing it
 * straight to Bun is a remote denial of service: `GET /%41` is enough to take
 * the server down, and no try/catch can stop it.
 *
 * Stoneware therefore decodes the path itself and hides any surviving "%" behind a
 * sentinel for the duration of the match. See report.md.
 *
 * Returns null for malformed encoding, which the caller treats as a 404.
 */
export function toMatchablePath(pathname: string): string | null {
  if (pathname.includes("\0")) return null;
  if (!pathname.includes("%") && !pathname.includes(PERCENT_SENTINEL)) return pathname;

  // Masking happens *before* decoding, deliberately. Decoding first would turn
  // "%2F" into a real "/" and let one encoded segment match a two-segment route,
  // which is a classic path-confusion bypass. Escapes stay encoded through the
  // match and are decoded per captured param instead.
  return pathname.split(PERCENT_SENTINEL).join("").split("%").join(PERCENT_SENTINEL);
}

/**
 * Undo the masking and percent-decode each captured param.
 *
 * Returns null if any param carries malformed encoding, which the caller treats
 * as a non-match rather than passing a half-decoded value to a template.
 */
function restoreParams(params: Record<string, string>): Record<string, string> | null {
  const restored: Record<string, string> = {};

  for (const [key, value] of Object.entries(params)) {
    const encoded = value.includes(PERCENT_SENTINEL)
      ? value.split(PERCENT_SENTINEL).join("%")
      : value;

    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded.includes("\0")) return null;
      restored[key] = decoded;
    } catch {
      // e.g. "/blog/%zz" - not a valid escape sequence.
      return null;
    }
  }

  return restored;
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
