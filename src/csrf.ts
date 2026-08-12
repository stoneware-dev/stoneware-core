/**
 * CSRF protection, built on `Bun.CSRF`.
 *
 * Verification is applied by the request pipeline to every mutating request
 * before any handler runs. It is not a per-route opt-in and there is no
 * decorator to remember (CLAUDE.md §9).
 */

import type { ResolvedConfig } from "./config.ts";

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
        `Missing CSRF token. Submit forms with Kiln's <Form> helper, or send the token ` +
        `in the "${config.csrf.headerName}" header.`,
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

  try {
    const body = await request.clone().formData();
    const value = body.get(config.csrf.fieldName);
    return typeof value === "string" ? value : null;
  } catch {
    // A malformed body cannot carry a valid token; fall through to rejection.
    return null;
  }
}
