/**
 * Framework configuration.
 *
 * Every security-relevant default here is safe with an empty config object.
 * Weakening one requires naming it explicitly (CLAUDE.md §10) - there is no
 * path to an insecure setup by omission.
 */

import { resolve } from "node:path";
import type { Observer } from "./observe.ts";

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
   * `Content-Security-Policy`.
   *
   * Three forms, in increasing order of how much you are taking on:
   *
   *   omit it        the default policy: no `unsafe-inline`, no `unsafe-eval`
   *   an object      the default policy, plus the origins you name
   *   a string       your policy, replacing the default entirely
   *   `false`        no header at all
   *
   * The object is the one to reach for when adding a third party. Naming the
   * origins you need keeps every other directive - `object-src 'none'`,
   * `base-uri 'self'`, `frame-ancestors 'none'` - exactly as the framework set
   * them:
   *
   * ```ts
   * csp: {
   *   scriptSrc: ["https://www.googletagmanager.com"],
   *   connectSrc: ["https://www.google-analytics.com"],
   *   imgSrc: ["https://www.google-analytics.com"],
   * }
   * ```
   *
   * Before the object form existed the only way to allow one origin was to
   * retype the whole policy as a string, and a policy retyped by hand is a
   * policy with a directive missing from it.
   */
  csp?: string | false | CSPSources;

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

  /**
   * Cross-origin access for `routes/api/`.
   *
   * Off by default. Same-origin requests never needed it, and turning it on
   * without meaning to is how an internal API becomes a public one.
   */
  cors?: CORSConfig;

  /**
   * Follow symbolic links out of `public/`.
   *
   * Off by default. A path is checked lexically before it is opened, but a
   * symlink is resolved at open time, so the two can disagree: a link inside
   * `public/` pointing anywhere on disk passes the check and then serves the
   * target. Blocking is the safe answer and matches nginx's `disable_symlinks`.
   *
   * Turn it on for a deliberate layout - a monorepo linking
   * `public/shared -> ../../assets` is the usual reason - and understand that a
   * link written into `public/` by anything else then serves whatever it points
   * at.
   */
  followSymlinks?: boolean;

  /**
   * Called once per request, with the finished response's status, the matched
   * route pattern, and how long the whole thing took.
   *
   * Nothing is logged per request without this. A server that narrates itself by
   * default is a server whose logs you turn off, and the useful shape of a
   * request log is specific to where it is being sent.
   *
   * ```ts
   * import { defineConfig, consoleObserver } from "stoneware";
   *
   * export default defineConfig({
   *   observe: consoleObserver(),
   * });
   * ```
   *
   * Or hand the event to something else - the signature is deliberately small
   * enough to adapt in one line:
   *
   * ```ts
   * observe: (event) => {
   *   metrics.timing("http.request", event.durationMs, {
   *     route: event.route ?? "unmatched",
   *     status: String(event.status),
   *   });
   *   if (event.error) Sentry.captureException(event.error);
   * },
   * ```
   *
   * `stoneware dev` installs `consoleObserver()` when this is unset, so
   * development prints request lines and production stays silent until asked.
   * Setting it here replaces that in both.
   */
  observe?: Observer;
}

export interface CORSConfig {
  /**
   * Origins allowed to call the API. A list, or `"*"` for any.
   *
   * `"*"` and `credentials: true` are incompatible - the browser rejects the
   * combination - and `resolveConfig` refuses it rather than letting the
   * failure surface as an opaque CORS error in someone's console.
   */
  origin: string | string[];
  /** Defaults to the safe set plus the usual mutating verbs. */
  methods?: string[];
  /** Request headers a caller may send. Defaults to content-type and the CSRF header. */
  headers?: string[];
  /** Allow cookies and Authorization on cross-origin requests. Off by default. */
  credentials?: boolean;
  /** Seconds a browser may cache the preflight. Defaults to 600. */
  maxAge?: number;
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
  cors: ResolvedCORS | null;
  followSymlinks: boolean;
  observe: Observer | null;
  dev: boolean;
}

export interface ResolvedCORS {
  origin: string | string[];
  methods: string[];
  headers: string[];
  credentials: boolean;
  maxAge: number;
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

/**
 * Extra origins to allow, per directive.
 *
 * Every field is *added to* the framework default rather than replacing it, so
 * `'self'` and the directives you did not mention survive. Naming a directive
 * the default policy has no entry for - `frame-src`, `worker-src` - creates it
 * seeded with `'self'`, because that is what it inherited from `default-src`
 * and dropping it would break same-origin frames and workers while allowing a
 * third party's.
 */
export interface CSPSources {
  defaultSrc?: string[];
  scriptSrc?: string[];
  styleSrc?: string[];
  imgSrc?: string[];
  fontSrc?: string[];
  connectSrc?: string[];
  frameSrc?: string[];
  workerSrc?: string[];
  mediaSrc?: string[];
  objectSrc?: string[];
  baseUri?: string[];
  formAction?: string[];
  frameAncestors?: string[];
}

/** `scriptSrc` -> `script-src`. */
function directiveName(key: string): string {
  return key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
}

/**
 * A source has to be one token.
 *
 * `;` would end the directive and begin another, so a value carrying one could
 * append `script-src 'unsafe-inline'` to a policy that never asked for it -
 * which matters because these values are exactly the kind read from an
 * environment variable or a CMS field. Whitespace is refused for the same
 * reason, and an empty string because it silently produces a malformed policy.
 */
function assertSource(directive: string, source: string): void {
  if (typeof source !== "string" || source.trim() === "") {
    throw new Error(`csp.${directive} contains an empty source.`);
  }
  if (/[;,]/.test(source) || /\s/.test(source)) {
    throw new Error(
      `csp.${directive} source ${JSON.stringify(source)} contains ";", "," or whitespace. ` +
        `Each source is one token - list several instead of joining them.`,
    );
  }
}

/**
 * The default policy with extra origins folded in.
 *
 * Exported so a project that wants to see what it will send can print it, and
 * so the same builder is used by the tests that guard the defaults.
 */
export function buildCSP(sources: CSPSources): string {
  const policy = new Map<string, string[]>();
  for (const directive of DEFAULT_CSP.split("; ")) {
    const [name, ...values] = directive.split(" ");
    policy.set(name!, values);
  }

  for (const [key, added] of Object.entries(sources)) {
    if (added === undefined) continue;
    const name = directiveName(key);
    for (const source of added) assertSource(key, source);

    // Absent from the default policy, so it was inheriting default-src. Seed
    // with 'self' or adding one origin would remove the site's own.
    const existing = policy.get(name) ?? ["'self'"];

    // `'none'` may not appear beside anything else - the browser treats the
    // whole directive as invalid. Adding a source means it is no longer none.
    const base = existing.length === 1 && existing[0] === "'none'" ? [] : existing;

    policy.set(name, [...new Set([...base, ...added])]);
  }

  return [...policy].map(([name, values]) => [name, ...values].join(" ")).join("; ");
}

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

function resolveCSP(csp: StonewareConfig["csp"]): string | false {
  if (csp === undefined) return DEFAULT_CSP;
  if (csp === false) return false;
  if (typeof csp === "string") return csp;
  return buildCSP(csp);
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
    // Resolved to a string here, once. Everything downstream - the response
    // header, the <meta> an export embeds, the _headers file it writes - keeps
    // reading a plain string, so the object form needs no support anywhere
    // else and cannot behave differently between SSR and a static export.
    csp: resolveCSP(config.csp),
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
    cors: resolveCORS(config.cors),
    followSymlinks: config.followSymlinks ?? false,
    observe: config.observe ?? null,
    dev,
  };
}

function resolveCORS(cors: CORSConfig | undefined): ResolvedCORS | null {
  if (cors === undefined) return null;

  const credentials = cors.credentials ?? false;
  if (cors.origin === "*" && credentials) {
    // The browser rejects this pairing outright. Failing here names the problem
    // instead of leaving it to appear as an unexplained CORS error at runtime.
    throw new Error(
      'cors.origin "*" cannot be combined with cors.credentials. ' +
        "List the origins you actually allow.",
    );
  }

  return {
    origin: cors.origin,
    methods: cors.methods ?? ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    headers: cors.headers ?? ["content-type", "x-csrf-token"],
    credentials,
    maxAge: cors.maxAge ?? 600,
  };
}

function parseTrustProxy(value: string | undefined): boolean | "proto" {
  if (value === undefined) return false;
  if (value === "proto") return "proto";
  return value === "1" || value.toLowerCase() === "true";
}

const CONFIG_FILENAMES = ["stoneware.config.ts", "stoneware.config.js"];

/**
 * The project's config file, or null if it has none.
 *
 * Separate from loading it because the build needs the path without the value:
 * it writes a static import of this file into the server entry, so the bundler
 * inlines the module rather than leaving a read behind. See `serverEntrySource`.
 */
export async function findConfigFile(root: string): Promise<string | null> {
  for (const name of CONFIG_FILENAMES) {
    const path = resolve(root, name);
    if (await Bun.file(path).exists()) return path;
  }
  return null;
}

/**
 * Validate whatever a config module exported.
 *
 * Shared with the generated server entry, which imports the config statically
 * and so cannot go through `loadConfigFile` at all.
 */
export function readConfigModule(module: Record<string, unknown>, label: string): StonewareConfig {
  const config = module.default ?? module.config;
  if (!config || typeof config !== "object") {
    throw new Error(`${label} must export a config object as its default export.`);
  }
  return config as StonewareConfig;
}

/** Load `stoneware.config.ts` from a project root, if one exists. */
export async function loadConfigFile(root: string): Promise<StonewareConfig> {
  const path = await findConfigFile(root);
  if (path === null) return {};

  const module = await import(Bun.pathToFileURL(path).href);
  return readConfigModule(module, path.split(/[\\/]/).pop() ?? path);
}
