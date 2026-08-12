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
    const matched = this.#router.match(pathname);
    if (!matched) return null;

    const module = await this.#import(matched.filePath);
    const params = { ...matched.params };

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
      };
    }

    throw new Error(
      `Route ${matched.filePath} exports neither a default component nor any HTTP ` +
        `method handlers (${HTTP_METHODS.join(", ")}).`,
    );
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

/** A page may export `head` to contribute to `<head>` without owning the document. */
export type HeadFn = (props: PageProps) => Child;
