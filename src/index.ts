/**
 * Stoneware's public API.
 *
 * Server-first by construction: nothing exported here reaches the browser
 * unless it is imported from a file under `islands/`.
 */

export { h, jsx, jsxs, jsxDEV, Fragment } from "./jsx-runtime.ts";
export { raw, escapeHTML, safeJSONStringify } from "./render/escape.ts";
export { renderToString } from "./render/render.ts";
export { Form } from "./helpers/form.tsx";
export { Boundary } from "./helpers/boundary.tsx";
export { Image } from "./helpers/image.tsx";
export { seo } from "./helpers/seo.tsx";
export { sitemap, sitemapXML } from "./helpers/sitemap.ts";
export { notFound, isNotFound } from "./helpers/not-found.ts";
export { requestURL } from "./routing/url.ts";
export { createApp, serve } from "./http/server.ts";
export { defineConfig, resolveConfig, loadConfigFile, buildCSP, DEFAULT_CSP } from "./config.ts";
export { Router } from "./routing/router.ts";
export { generateToken, verifyRequest, isSafeMethod } from "./http/csrf.ts";
export { csrfToken, csrfFieldName } from "./http/public-csrf.ts";
export { buildIslands, CLIENT_ASSET_PREFIX } from "./build/build.ts";
export { discoverIslands, loadIslands, buildIslandRegistry } from "./build/islands.ts";
export { buildDocument } from "./render/document.ts";
export { consoleObserver, formatEvent } from "./http/observe.ts";

export type { Child, Component, PageComponent, Props, VNode, RawHTML } from "./render/types.ts";
export type { BoundaryProps } from "./helpers/boundary.tsx";
export type {
  Observer,
  RequestEvent,
  RequestKind,
  ConsoleObserverOptions,
} from "./http/observe.ts";
export type {
  StonewareConfig,
  ResolvedConfig,
  CSRFConfig,
  CORSConfig,
  CSPSources,
} from "./config.ts";
export type { Middleware, MiddlewareContext, Locals } from "./http/middleware.ts";
export type {
  PageProps,
  ActionContext,
  ActionHandler,
  MatchedRoute,
  ErrorPageProps,
  HeadFn,
} from "./routing/router.ts";
export type { StonewareApp, ServeResult } from "./http/server.ts";
export type { ImageProps } from "./helpers/image.tsx";
export type {
  SEOOptions,
  OpenGraphOptions,
  ArticleOptions,
  XCardOptions,
  TwitterOptions,
  RobotsOptions,
  AlternateLink,
} from "./helpers/seo.tsx";
export type { SitemapEntry, SitemapOptions, ChangeFrequency } from "./helpers/sitemap.ts";
export type { IslandManifest } from "./build/build.ts";
export type { RenderResult, CollectedIsland } from "./render/render.ts";
