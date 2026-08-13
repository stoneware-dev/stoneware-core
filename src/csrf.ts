/**
 * CSRF protection, built on `Bun.CSRF`.
 *
 * Verification is applied by the request pipeline to every mutating request
 * before any handler runs. It is not a per-route opt-in and there is no
 * decorator to remember (CLAUDE.md §9).
 */

import type { ResolvedConfig } from "./config.ts";

/**
 * Largest body this module will parse looking for a token.
 *
 * Extraction happens *before* verification, by necessity - the token is what
 * verification needs. That makes it reachable by anyone, so an unbounded parse
 * here is a free amplification: a few bytes of attacker request turning into
 * megabytes of server-side multipart parsing.
 *
 * A token is a few hundred bytes. A body larger than this is not carrying one
 * that we need to find by parsing, so it is refused with an explanation instead.
 */
const MAX_TOKEN_BODY_BYTES = 1024 * 1024;

/** Methods that must not change server state, and so need no token. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/** Mint a token for embedding in a form. */
export function generateToken(config: ResolvedConfig): string {
  return Bun.CSRF.generate(config.csrf.secret, {
    expiresIn: config.csrf.expiresIn,
  });
}

export interface CSRFResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify the token on a mutating request.
 *
 * The request body is read from a `clone()` so the handler still receives an
 * unconsumed stream - the developer never has to know verification happened.
 */
export async function verifyRequest(
  request: Request,
  config: ResolvedConfig,
): Promise<CSRFResult> {
  if (isSafeMethod(request.method)) return { ok: true };

  const token = await extractToken(request, config);
  if (!token) {
    return {
      ok: false,
      reason:
        `Missing CSRF token. Submit forms with Stoneware's <Form> helper, or send the token ` +
        `in the "${config.csrf.headerName}" header. A body over 1 MB is not searched for a ` +
        `token, so a large upload must send it in that header.`,
    };
  }

  const valid = Bun.CSRF.verify(token, { secret: config.csrf.secret });
  return valid ? { ok: true } : { ok: false, reason: "Invalid or expired CSRF token." };
}

async function extractToken(
  request: Request,
  config: ResolvedConfig,
): Promise<string | null> {
  const fromHeader = request.headers.get(config.csrf.headerName);
  if (fromHeader) return fromHeader;

  const contentType = request.headers.get("content-type") ?? "";
  const isForm =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data");
  if (!isForm) return null;

  // Refuse to parse a large body just to look for a token. A client uploading
  // one should send the token in the header, which is read above and costs
  // nothing regardless of body size.
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_TOKEN_BODY_BYTES) return null;

  try {
    const body = await request.clone().formData();
    const value = body.get(config.csrf.fieldName);
    return typeof value === "string" ? value : null;
  } catch {
    // A malformed body cannot carry a valid token; fall through to rejection.
    return null;
  }
}
