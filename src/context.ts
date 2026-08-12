/**
 * Request-scoped state for the current render.
 *
 * Templates are plain functions with no context parameter (CLAUDE.md §2.2), but
 * a few framework helpers - `<Form>` and `csrfToken()` - need the active config.
 * `AsyncLocalStorage` carries it across the whole request, including any awaits
 * a page performs while loading data, without adding a parameter to every
 * template signature.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ResolvedConfig } from "./config.ts";

export interface RenderContext {
  config: ResolvedConfig;
  request: Request;
  url: URL;
}

const storage = new AsyncLocalStorage<RenderContext>();

/** Run `fn` with `context` installed for its entire async lifetime. */
export function withRenderContext<T>(context: RenderContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRenderContext(): RenderContext {
  const context = storage.getStore();
  if (context === undefined) {
    throw new Error(
      "No active render context. Kiln helpers such as <Form> and csrfToken() may only " +
        "be called while a route is rendering.",
    );
  }
  return context;
}

/** Non-throwing variant, for code paths that can degrade gracefully. */
export function peekRenderContext(): RenderContext | null {
  return storage.getStore() ?? null;
}
