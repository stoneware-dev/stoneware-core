/**
 * Turning a status and a message into a Response, and the headers every
 * response leaves with.
 *
 * The pipeline in server.ts has one exit, and it is here. `withSecurityHeaders`
 * fills gaps rather than overwriting, so a route may set its own CSP but cannot
 * drop the rest — which is what makes "a new code path cannot skip them" true
 * by construction rather than by review.
 *
 * The content-negotiation split matters as much: an API client that asked for
 * JSON must not be handed a page of markup to parse, and a browser navigating
 * to the same failing route must not be handed JSON.
 */

import { SECURITY_HEADERS } from "../config.ts";
import { corsHeaders } from "./cors.ts";
import type { ResolvedConfig } from "../config.ts";

/**
 * Apply the security headers to a response, without touching its body.
 *
 * Mutating the existing `Headers` matters for static files: re-wrapping a
 * `Bun.file()` response in a new `Response` would give up Bun's direct
 * file-serving path and stream the bytes through userland instead.
 *
 * A response that came from `fetch()` has immutable headers; those are copied.
 */
export function withSecurityHeaders(response: Response, config: ResolvedConfig): Response {
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
export function withCORS(response: Response, request: Request, config: ResolvedConfig): Response {
  if (!config.cors) return response;

  const headers = corsHeaders(request, config.cors);
  if (headers === null) return response;

  for (const [name, value] of headers) response.headers.append(name, value);
  return response;
}

export function errorResponse(
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
export function prefersJSON(request: Request): boolean {
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
