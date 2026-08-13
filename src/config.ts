/**
 * Framework configuration.
 *
 * Every security-relevant default here is safe with an empty config object.
 * Weakening one requires naming it explicitly (CLAUDE.md §10) - there is no
 * path to an insecure setup by omission.
 */

import { resolve } from "node:path";

export interface CSRFConfig {
  /**
   * Secret used to sign tokens. Falls back to `STONEWARE_CSRF_SECRET`, and in dev
   * only, to an ephemeral per-process secret.
   *
   * Prefer the environment variable over this field so the secret is never
   * committed. Bun loads `.env` natively, so putting it there is enough.
   *
   * Production deployments must set it: without one, tokens are invalidated by
   * every restart and are not shared across processes.
   */
  secret?: string;
  /** Token lifetime in milliseconds. Default: 24 hours. */
  expiresIn?: number;
  /** Name of the hidden form field carrying the token. */
  fieldName?: string;
  /** Request header checked for the token, for non-form (JSON/fetch) requests. */
  headerName?: string;
}

export interface StonewareConfig {
  /** Project root. Every other path is resolved against it. */
  root?: string;
  port?: number;
  hostname?: string;

  routesDir?: string;
  islandsDir?: string;
  publicDir?: string;
  /** Build output directory, relative to root. */
  outDir?: string;

  /**
   * `Content-Security-Policy` header value.
   *
   * Defaults to a policy with no `unsafe-inline` and no `unsafe-eval`. Pass a
   * string to replace it, or `false` to omit the header - an explicit,
   * greppable choice, never an accident.
   */
  csp?: string | false;

  csrf?: CSRFConfig;

  /**
   * Trust `X-Forwarded-*` headers when reconstructing the request URL.
   *
   * Every platform that terminates TLS for you - Render, Railway, Fly, Heroku,
   * Vercel, nginx - forwards a plain HTTP request. Without this the app sees
   * `http://` on a site served over `https://`, so canonical URLs, `og:image`
   * and any absolute link it builds point at the insecure origin.
   *
   * Off by default, and deliberately: these headers are trivially forged by
   * anyone who can reach the app directly. Trusting a forged `X-Forwarded-Host`
   * is how absolute URLs get poisoned. Turn it on only when something you
   * control sits in front.
   *
   *   `true`        trust the scheme and the host
   *   `"proto"`     trust only the scheme - safe on any host, and enough to fix
   *                 http/https confusion, which is the common case
   */
  trustProxy?: boolean | "proto";
}

/** Fully-resolved configuration used internally. Every path is absolute. */
export interface ResolvedConfig {
  root: string;
  port: number;
  hostname: string;
  routesDir: string;
  islandsDir: string;
  publicDir: string;
  outDir: string;
  csp: string | false;
  csrf: Required<Omit<CSRFConfig, "secret">> & { secret: string };
  trustProxy: boolean | "proto";
  dev: boolean;
}

/**
 * A restrictive policy that still allows a normal Stoneware app to work.
 *
 * `script-src 'self'` is deliberate and load-bearing: Stoneware never emits inline
 * executable script, so no `unsafe-inline` and no nonce plumbing is required.
 */
export const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/** Security headers sent alongside the CSP on every HTML response. */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
};

/** Identity helper that gives config files type inference. */
export function defineConfig(config: StonewareConfig): StonewareConfig {
  return config;
}

let ephemeralSecret: string | undefined;

function resolveCSRFSecret(configured: string | undefined, dev: boolean): string {
  const secret = configured ?? Bun.env.STONEWARE_CSRF_SECRET;
  if (secret) return secret;

  if (!dev) {
    throw new Error(
      "No CSRF secret configured. Set STONEWARE_CSRF_SECRET in .env (Bun loads it automatically), " +
        "in your deployment environment, or as csrf.secret in stoneware.config.ts. Without it, " +
        "tokens do not survive a restart and are not valid across multiple server processes.",
    );
  }

  if (!ephemeralSecret) {
    ephemeralSecret = crypto.randomUUID() + crypto.randomUUID();
    console.warn(
      "[stoneware] No STONEWARE_CSRF_SECRET set - using an ephemeral secret for this dev process. " +
        "Forms rendered before a restart will fail verification after it. " +
        "Add STONEWARE_CSRF_SECRET to .env to make it stable.",
    );
  }
  return ephemeralSecret;
}

export function resolveConfig(config: StonewareConfig = {}, dev = false): ResolvedConfig {
  const root = resolve(config.root ?? process.cwd());

  return {
    root,
    // PORT wins over the config file so a deploy target (and the CLI's --port,
    // which sets it) can override without editing source.
    port: Bun.env.PORT ? Number(Bun.env.PORT) : (config.port ?? 3000),
    // In development, bind loopback only — a dev server should not be reachable
    // from the rest of the network. In production the opposite is required:
    // Render, Railway, Fly and every container runtime reach the process through
    // a proxy on another interface, so binding to localhost makes the service
    // unreachable and the platform's health check fails with no useful error.
    hostname: config.hostname ?? Bun.env.HOST ?? (dev ? "localhost" : "0.0.0.0"),
    routesDir: resolve(root, config.routesDir ?? "routes"),
    islandsDir: resolve(root, config.islandsDir ?? "islands"),
    publicDir: resolve(root, config.publicDir ?? "public"),
    outDir: resolve(root, config.outDir ?? ".stoneware"),
    csp: config.csp === undefined ? DEFAULT_CSP : config.csp,
    csrf: {
      secret: resolveCSRFSecret(config.csrf?.secret, dev),
      expiresIn: config.csrf?.expiresIn ?? 24 * 60 * 60 * 1000,
      fieldName: config.csrf?.fieldName ?? "_csrf",
      headerName: config.csrf?.headerName ?? "x-csrf-token",
    },
    // STONEWARE_TRUST_PROXY lets a deploy turn this on without a code change,
    // which matters because whether a proxy is in front is a property of the
    // environment rather than of the project.
    trustProxy: config.trustProxy ?? parseTrustProxy(Bun.env.STONEWARE_TRUST_PROXY),
    dev,
  };
}

function parseTrustProxy(value: string | undefined): boolean | "proto" {
  if (value === undefined) return false;
  if (value === "proto") return "proto";
  return value === "1" || value.toLowerCase() === "true";
}

/** Load `stoneware.config.ts` from a project root, if one exists. */
export async function loadConfigFile(root: string): Promise<StonewareConfig> {
  for (const name of ["stoneware.config.ts", "stoneware.config.js"]) {
    const path = resolve(root, name);
    if (!(await Bun.file(path).exists())) continue;

    const module = await import(Bun.pathToFileURL(path).href);
    const config = module.default ?? module.config;
    if (!config || typeof config !== "object") {
      throw new Error(`${name} must export a config object as its default export.`);
    }
    return config as StonewareConfig;
  }
  return {};
}
