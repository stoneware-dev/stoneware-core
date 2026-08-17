/**
 * Stoneware's public API.
 *
 * Server-first by construction: nothing exported here reaches the browser
 * unless it is imported from a file under `islands/`.
 */

export { h, jsx, jsxs, jsxDEV, Fragment } from "./jsx-runtime.ts";
export { raw, escapeHTML, safeJSONStringify } from "./escape.ts";
export { renderToString } from "./render.ts";
export { Form } from "./form.tsx";
export { Boundary } from "./boundary.tsx";
export { Image } from "./image.tsx";
export { seo } from "./seo.tsx";
export { notFound, isNotFound } from "./not-found.ts";
export { requestURL } from "./url.ts";
export { createApp, serve } from "./server.ts";
export { defineConfig, resolveConfig, loadConfigFile, buildCSP, DEFAULT_CSP } from "./config.ts";
export { Router } from "./router.ts";
export { generateToken, verifyRequest, isSafeMethod } from "./csrf.ts";
export { csrfToken, csrfFieldName } from "./public-csrf.ts";
export { buildIslands, CLIENT_ASSET_PREFIX } from "./build.ts";
export { discoverIslands, loadIslands, buildIslandRegistry } from "./islands.ts";
export { buildDocument } from "./document.ts";
export { consoleObserver, formatEvent } from "./observe.ts";

export type { Child, Component, PageComponent, Props, VNode, RawHTML } from "./types.ts";
export type { BoundaryProps } from "./boundary.tsx";
export type {
  Observer,
  RequestEvent,
  RequestKind,
  ConsoleObserverOptions,
} from "./observe.ts";
export type {
  StonewareConfig,
  ResolvedConfig,
  CSRFConfig,
  CORSConfig,
  CSPSources,
} from "./config.ts";
export type { Middleware, MiddlewareContext, Locals } from "./middleware.ts";
export type {
  PageProps,
  ActionContext,
  ActionHandler,
  MatchedRoute,
  ErrorPageProps,
  HeadFn,
} from "./router.ts";
export type { StonewareApp, ServeResult } from "./server.ts";
export type { ImageProps } from "./image.tsx";
export type {
  SEOOptions,
  OpenGraphOptions,
  ArticleOptions,
  XCardOptions,
  TwitterOptions,
  RobotsOptions,
  AlternateLink,
} from "./seo.tsx";
export type { IslandManifest } from "./build.ts";
export type { RenderResult, CollectedIsland } from "./render.ts";
