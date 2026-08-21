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
import type { ResolvedConfig } from "../config.ts";

export interface RenderContext {
  config: ResolvedConfig;
  request: Request;
  url: URL;
  /**
   * Set when this render issued a CSRF token.
   *
   * Such a page is unique to one visitor, so it must never reach a shared
   * cache — handing a second visitor a first visitor's token would defeat the
   * protection entirely. The response layer reads this to decide.
   */
  personalized: boolean;
  /**
   * `<link rel="preload">` tags contributed from inside the body.
   *
   * A priority `<Image>` renders where the page puts it, but its preload only
   * helps in `<head>`, which the document assembler has already passed by the
   * time the body renders. Collecting here lets the tag travel backwards.
   *
   * A Set because the same image used twice deserves one preload, not two.
   */
  preloads: Set<string>;
  /** True while the route's `head` export is being rendered. */
  renderingHead: boolean;
  /** Set when `seo()` ran outside `head`. Checked once, after the render. */
  seoOutsideHead: boolean;
  /**
   * Errors a `<Boundary>` absorbed during this render.
   *
   * The response is a 200 with the fallback in it, which is the whole point —
   * but an absorbed error that nothing can see is just a hidden failure, and
   * this project has shipped enough of those. The response layer hands these to
   * the `observe` hook so a reporting backend gets them.
   */
  caught: unknown[];
}

/**
 * Record an error a `<Boundary>` absorbed.
 *
 * A no-op outside a render, so `renderToString` still works standalone.
 */
export function noteCaught(error: unknown): void {
  storage.getStore()?.caught.push(error);
}

/** Mark the current render as visitor-specific. Safe to call outside a render. */
export function markPersonalized(): void {
  const context = storage.getStore();
  if (context !== undefined) context.personalized = true;
}

/**
 * Record that `seo()` was called, and whether it was in the right place.
 *
 * Not an error on its own: a page that renders its own `<html>` may legitimately
 * call `seo()` inside its own `<head>`. Only the caller knows whether the tags
 * ended up somewhere they work, so the check happens after the render.
 */
export function noteSEOCall(): void {
  const context = storage.getStore();
  if (context !== undefined && !context.renderingHead) context.seoOutsideHead = true;
}

/**
 * Ask for a `<link rel="preload">` in this page's head.
 *
 * A no-op outside a render, so `renderToString` still works standalone - in a
 * test, or anywhere a fragment is rendered without a request.
 */
export function addPreload(tag: string): void {
  storage.getStore()?.preloads.add(tag);
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
      "No active render context. Stoneware helpers such as <Form> and csrfToken() may only " +
        "be called while a route is rendering.",
    );
  }
  return context;
}

/** Non-throwing variant, for code paths that can degrade gracefully. */
export function peekRenderContext(): RenderContext | null {
  return storage.getStore() ?? null;
}
