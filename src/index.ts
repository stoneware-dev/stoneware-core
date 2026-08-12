/**
 * Sinter's public API.
 *
 * Server-first by construction: nothing exported here reaches the browser
 * unless it is imported from a file under `islands/`.
 */

export { h, jsx, jsxs, jsxDEV, Fragment } from "./jsx-runtime.ts";
export { raw, escapeHTML, safeJSONStringify } from "./escape.ts";
export { renderToString } from "./render.ts";
export { Form } from "./form.tsx";
export { createApp, serve } from "./server.ts";
export { defineConfig, resolveConfig, loadConfigFile, DEFAULT_CSP } from "./config.ts";
export { Router } from "./router.ts";
export { generateToken, verifyRequest, isSafeMethod } from "./csrf.ts";
export { csrfToken, csrfFieldName } from "./public-csrf.ts";
export { buildIslands, CLIENT_ASSET_PREFIX } from "./build.ts";
export { discoverIslands, loadIslands, buildIslandRegistry } from "./islands.ts";
export { buildDocument } from "./document.ts";

export type { Child, Component, Props, VNode, RawHTML } from "./types.ts";
export type { SinterConfig, ResolvedConfig, CSRFConfig } from "./config.ts";
export type { PageProps, ActionContext, ActionHandler, MatchedRoute } from "./router.ts";
export type { SinterApp, ServeResult } from "./server.ts";
export type { IslandManifest } from "./build.ts";
export type { RenderResult, CollectedIsland } from "./render.ts";
