/**
 * Cross-origin access for API routes.
 *
 * Off unless a project configures it. An API that only its own pages call never
 * needed CORS, and enabling it by default would quietly make every internal
 * endpoint callable from any site.
 *
 * Note how this interacts with CSRF: a cross-origin `POST` still has to carry a
 * valid token, because verification runs before anything here is consulted.
 * CORS decides who may *read* the response; it does not decide who may act.
 */

import type { ResolvedCORS } from "../config.ts";

/**
 * The `Access-Control-*` headers for this request, or null when the origin is
 * not allowed - in which case nothing is added and the browser blocks the read.
 */
export function corsHeaders(request: Request, cors: ResolvedCORS): Headers | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;

  const allowed = isAllowed(origin, cors.origin);
  if (!allowed) return null;

  const headers = new Headers();

  // Echo the caller's origin rather than "*" whenever the allow-list is
  // specific, so a cache cannot serve one origin's response to another.
  headers.set("Access-Control-Allow-Origin", cors.origin === "*" ? "*" : origin);
  if (cors.credentials) headers.set("Access-Control-Allow-Credentials", "true");

  // Without this a shared cache can hand a response allowing origin A to a
  // request from origin B.
  if (cors.origin !== "*") headers.append("Vary", "Origin");

  return headers;
}

/**
 * Answer a preflight.
 *
 * A browser sends `OPTIONS` before any request that is not simple, and will not
 * send the real one until this succeeds. Returning 204 with the allowed methods
 * and headers is the whole protocol.
 */
export function preflightResponse(request: Request, cors: ResolvedCORS): Response | null {
  if (request.method !== "OPTIONS") return null;
  if (request.headers.get("access-control-request-method") === null) return null;

  const headers = corsHeaders(request, cors);
  if (headers === null) return new Response(null, { status: 403 });

  headers.set("Access-Control-Allow-Methods", cors.methods.join(", "));
  headers.set("Access-Control-Allow-Headers", cors.headers.join(", "));
  headers.set("Access-Control-Max-Age", String(cors.maxAge));

  return new Response(null, { status: 204, headers });
}

function isAllowed(origin: string, allowed: string | string[]): boolean {
  if (allowed === "*") return true;
  if (typeof allowed === "string") return origin === allowed;
  return allowed.includes(origin);
}
