/**
 * Server renderer: VNode tree in, HTML string out.
 *
 * This is a render-once-to-string operation, not a reconciler (CLAUDE.md §6).
 * The tree is walked exactly once per request, depth-first, appending to a
 * string. There is no previous tree, no diff, and nothing retained afterwards.
 *
 * Every interpolated value passes through `Bun.escapeHTML()` on the way out.
 * The single exception is a value explicitly wrapped in `raw()`.
 */

import { Signal } from "@preact/signals-core";
import {
  ATTRIBUTE_ALIASES,
  EVENT_HANDLER,
  VALID_ATTRIBUTE_NAME,
  unsafeURLReason,
} from "./attributes.ts";
import { peekRenderContext } from "./context.ts";
import { escapeHTML, safeJSONStringify } from "./escape.ts";
import { Fragment, isRaw, isVNode } from "./types.ts";
import type { Child, Component, Props, VNode } from "./types.ts";

/** Elements that must not be given a closing tag. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Elements whose content is raw text (CDATA) rather than markup. Stoneware refuses
 * to interpolate dynamic values into these at all - escaping rules inside
 * `<script>`/`<style>` differ from HTML text, and getting them subtly wrong is
 * how injection bugs happen. Use a dedicated helper or an external file.
 */
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);


/** When an island instance hydrates. `load` is the default. */
export type HydrationStrategy = "load" | "visible" | "idle" | "media";

export interface CollectedIsland {
  /** Island name, derived from its filename (e.g. `Counter`). */
  name: string;
  /** Per-render unique id tying the markup to its props payload. */
  id: string;
  /** Props the island was rendered with, replayed verbatim on the client. */
  props: Props;
  /** Chosen by a `client:*` directive on the usage site. */
  strategy: HydrationStrategy;
  /** The media query, for `client:media` only. */
  query?: string;
}

export interface RenderOptions {
  /**
   * Maps a component function to its island name. Stoneware identifies islands by
   * function identity rather than by a marker the author has to write, so a
   * file in `islands/` is an island purely because of where it lives
   * (CLAUDE.md §5).
   */
  islands?: Map<Component<any>, string>;
}

export interface RenderResult {
  html: string;
  /** Islands encountered during this render, in document order. */
  islands: CollectedIsland[];
}

interface Context {
  islands: Map<Component<any>, string>;
  collected: CollectedIsland[];
  nextId: number;
}

/** Render a tree to HTML, collecting any islands encountered along the way. */
export function renderToString(child: Child, options: RenderOptions = {}): RenderResult {
  const ctx: Context = {
    islands: options.islands ?? new Map(),
    collected: [],
    nextId: 0,
  };
  const html = renderChild(child, ctx);
  return { html, islands: ctx.collected };
}

function renderChild(child: Child, ctx: Context): string {
  // Booleans render as nothing so `{cond && <p/>}` works as expected.
  if (child == null || typeof child === "boolean") return "";

  if (typeof child === "string") return escapeHTML(child);
  if (typeof child === "number" || typeof child === "bigint") return escapeHTML(String(child));

  if (isRaw(child)) return child.value;

  // A signal renders its current value. On the server that is a one-time read;
  // the reactive binding is established later, in the browser.
  if (child instanceof Signal) return renderChild(child.value, ctx);

  if (Array.isArray(child)) {
    let out = "";
    for (const item of child) out += renderChild(item, ctx);
    return out;
  }

  if (isVNode(child)) return renderVNode(child, ctx);

  // An async component nested inside JSX. Rendering is a single synchronous
  // walk to a string, so there is no point at which this could be awaited -
  // only the route's own default export gets that, because the server awaits it
  // before rendering starts. Naming the rule beats "cannot render value of type
  // object", which sends people looking at their data.
  if (typeof (child as { then?: unknown }).then === "function") {
    throw new TypeError(
      `A component returned a promise while rendering.\n` +
        `Only a route's default export may be async - the server awaits that one ` +
        `call before rendering begins. A component nested inside JSX cannot be, ` +
        `because rendering never awaits.\n\n` +
        `Fetch in the route and pass the result down as props.`,
    );
  }

  // A React element got here, which means JSX was compiled against React's
  // runtime rather than Stoneware's. Naming that beats "cannot render value of
  // type object", which sends people looking at their data.
  if (isReactElement(child)) {
    throw new TypeError(
      `This JSX was compiled with React's runtime, not Stoneware's.\n` +
        `Set the compiler options in tsconfig.json:\n\n` +
        `  "jsx": "react-jsx",\n` +
        `  "jsxImportSource": "stoneware"\n\n` +
        `A project created with create-stoneware has these already; a file outside ` +
        `the project's tsconfig, or an editor using a different one, is the usual cause.`,
    );
  }

  throw new TypeError(
    `Cannot render value of type ${typeof child}. ` +
      `Templates may return elements, strings, numbers, arrays, signals, or null.`,
  );
}

/**
 * Is this a React element rather than one of ours?
 *
 * React brands its elements with a `$$typeof` symbol. The name changed in React
 * 19, so both are checked - a mismatch here would put the misleading error back.
 */
function isReactElement(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;

  const brand = (value as { $$typeof?: unknown }).$$typeof;
  return (
    brand === Symbol.for("react.element") || brand === Symbol.for("react.transitional.element")
  );
}

function renderVNode(vnode: VNode, ctx: Context): string {
  const { type, props } = vnode;

  if (type === Fragment) return renderChild(props.children as Child, ctx);

  if (typeof type === "function") {
    const islandName = ctx.islands.get(type);
    if (islandName !== undefined) return renderIsland(islandName, type, props, ctx);
    // A plain template function: called once, on the server, per request.
    return renderChild(type(props), ctx);
  }

  if (typeof type !== "string") {
    throw new TypeError(`Invalid element type: ${String(type)}`);
  }

  return renderElement(type, props, ctx);
}

function renderElement(tag: string, props: Props, ctx: Context): string {
  if (!VALID_ATTRIBUTE_NAME.test(tag)) {
    throw new Error(`Invalid element name: ${JSON.stringify(tag)}`);
  }

  let html = `<${tag}${renderAttributes(props, tag)}>`;

  if (VOID_ELEMENTS.has(tag.toLowerCase())) {
    // A void element with children is a mistake worth surfacing loudly rather
    // than silently dropping the content.
    if (props.children != null && props.children !== false) {
      throw new Error(`<${tag}> is a void element and cannot have children.`);
    }
    return html;
  }

  const dangerous = props.dangerouslySetInnerHTML as { __html?: string } | undefined;
  if (dangerous != null) {
    html += String(dangerous.__html ?? "");
  } else if (RAW_TEXT_ELEMENTS.has(tag.toLowerCase())) {
    html += renderRawTextContent(tag, props.children as Child);
  } else {
    html += renderChild(props.children as Child, ctx);
  }

  return `${html}</${tag}>`;
}

/**
 * `<script>` and `<style>` bodies must be literal, author-written strings.
 * Escaping cannot make an arbitrary value safe in these contexts, so rather
 * than pretend otherwise Stoneware rejects anything dynamic.
 */
function renderRawTextContent(tag: string, children: Child): string {
  const parts = Array.isArray(children) ? children : [children];
  let out = "";

  for (const part of parts) {
    if (part == null || part === false || part === true) continue;

    if (isRaw(part)) {
      out += part.value;
      continue;
    }
    if (typeof part === "string") {
      if (part.includes("</")) {
        throw new Error(`<${tag}> content may not contain "</" - it would terminate the element early.`);
      }
      out += part;
      continue;
    }
    throw new Error(
      `<${tag}> may only contain literal strings. Interpolating values here cannot be made safe by escaping; ` +
        `serve the content from a file, or wrap an audited literal in raw().`,
    );
  }

  return out;
}

function renderAttributes(props: Props, tag: string): string {
  let out = "";

  for (const name in props) {
    if (name === "children" || name === "key" || name === "ref") continue;
    if (name === "dangerouslySetInnerHTML") continue;
    // Event handlers only mean something once an island is hydrated.
    if (EVENT_HANDLER.test(name)) continue;

    // A directive here has reached a plain element rather than an island, so
    // nothing would ever act on it. Silently rendering it as an attribute is
    // the worst outcome: the page looks correct and never hydrates lazily.
    if (name.startsWith(DIRECTIVE_PREFIX)) {
      throw new Error(
        `<${tag}> has a hydration directive ${JSON.stringify(name)}, but only islands hydrate. ` +
          `Move the directive to the island component itself.`,
      );
    }

    const attribute = ATTRIBUTE_ALIASES[name] ?? name;
    if (!VALID_ATTRIBUTE_NAME.test(attribute)) {
      throw new Error(`Invalid attribute name ${JSON.stringify(name)} on <${tag}>.`);
    }

    let value = props[name];
    if (value instanceof Signal) value = value.value;

    if (value == null || value === false) continue;
    if (value === true) {
      out += ` ${attribute}`;
      continue;
    }

    if (attribute === "style") warnAboutInlineStyle(tag);
    const serialized = attribute === "style" ? serializeStyle(value) : String(value);
    const unsafe = unsafeURLReason(attribute, serialized);
    if (unsafe !== null) {
      throw new Error(
        `<${tag} ${attribute}="..."> has a ${unsafe} URL, which executes when followed. ` +
          `Escaping cannot make it safe.
` +
          `If this value comes from your data, validate the scheme before rendering it; ` +
          `for a button that runs code, use an island with an onClick handler instead.`,
      );
    }
    out += ` ${attribute}="${escapeHTML(serialized)}"`;
  }

  return out;
}

function serializeStyle(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return String(value);

  let css = "";
  for (const [property, raw] of Object.entries(value)) {
    if (raw == null || raw === false) continue;
    // `backgroundColor` -> `background-color`; `--custom` is passed through.
    const name = property.startsWith("--")
      ? property
      : property.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`);
    const unit = typeof raw === "number" && raw !== 0 && !UNITLESS_PROPERTIES.has(name) ? "px" : "";
    css += `${name}:${raw}${unit};`;
  }
  return css;
}

const UNITLESS_PROPERTIES = new Set([
  "opacity", "z-index", "flex", "flex-grow", "flex-shrink", "order",
  "line-height", "font-weight", "zoom", "grid-row", "grid-column",
]);

/* -------------------------------------------------------------------------- */
/* Islands                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Render an island's initial HTML and tag its root element so the client
 * runtime can find it.
 *
 * The markers live on the island's own root element rather than on a wrapper,
 * so the served HTML has no extra node and no layout impact. The cost is that
 * an island must render exactly one element - enforced here with an explicit
 * error rather than silently mis-hydrating.
 */
function renderIsland(name: string, component: Component<any>, props: Props, ctx: Context): string {
  const id = `stoneware-${ctx.collected.length}`;

  // The directive is an instruction to the framework, not data for the island:
  // it is stripped before the component sees it and before it reaches the
  // payload, so an island never has to know it exists.
  const { strategy, query, rest } = takeDirective(name, props);

  assertSerializableProps(name, rest);
  warnAboutSecretsInProps(name, rest);
  ctx.collected.push({ name, id, props: rest, strategy, query });

  // Resolve through any wrapper components until an intrinsic element appears.
  let resolved = component(rest) as Child;
  let guard = 0;
  while (isVNode(resolved) && typeof resolved.type === "function") {
    if (++guard > 100) {
      throw new Error(`Island "${name}" exceeded 100 levels of component nesting at its root.`);
    }
    resolved = resolved.type(resolved.props) as Child;
  }

  if (!isVNode(resolved) || typeof resolved.type !== "string") {
    throw new Error(
      `Island "${name}" must render exactly one HTML element at its root, ` +
        `because that element carries the hydration marker. ` +
        `Wrap the contents in a single element such as <div>.`,
    );
  }

  const marked: Props = {
    ...resolved.props,
    "data-stoneware-island": name,
    "data-stoneware-id": id,
  };

  return renderElement(resolved.type, marked, ctx);
}

const DIRECTIVE_PREFIX = "client:";

const STRATEGIES: Record<string, HydrationStrategy> = {
  "client:load": "load",
  "client:visible": "visible",
  "client:idle": "idle",
  "client:media": "media",
};

/**
 * Read the `client:*` directive off an island's props, if there is one.
 *
 * Two directives on one usage is an error rather than a precedence rule to
 * memorize - there is no sensible answer to `<Chart client:idle client:visible />`
 * and guessing one would be worse than saying so.
 */
function takeDirective(
  name: string,
  props: Props,
): { strategy: HydrationStrategy; query?: string; rest: Props } {
  let strategy: HydrationStrategy = "load";
  let query: string | undefined;
  let found: string | undefined;
  const rest: Props = {};

  for (const [key, value] of Object.entries(props)) {
    if (!key.startsWith(DIRECTIVE_PREFIX)) {
      rest[key] = value;
      continue;
    }

    const resolved = STRATEGIES[key];
    if (resolved === undefined) {
      throw new Error(
        `Island "${name}" has an unknown directive "${key}". ` +
          `Valid directives are: ${Object.keys(STRATEGIES).join(", ")}.`,
      );
    }
    if (found !== undefined) {
      throw new Error(
        `Island "${name}" has two hydration directives, "${found}" and "${key}". ` +
          `An island instance hydrates once, so it can only have one.`,
      );
    }

    found = key;
    strategy = resolved;

    if (resolved === "media") {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
          `Island "${name}" uses client:media, which needs a media query — ` +
            `for example client:media="(min-width: 60rem)".`,
        );
      }
      query = value;
    }
  }

  return { strategy, query, rest };
}

/**
 * Key names that usually mean "this should not leave the server".
 *
 * Deliberately narrow. A prop called `token` is not on this list, because
 * `csrfToken` is a documented Stoneware pattern and a warning that fires on
 * correct code is a warning people learn to ignore.
 */
const SECRET_KEY = new RegExp(
  [
    "password",
    "passwd",
    "\bpwd\b",
    "secret",
    "private[_-]?key",
    "api[_-]?key",
    "access[_-]?token",
    "refresh[_-]?token",
    "bearer",
    "credential",
    "authorization",
    "session[_-]?(id|token)",
    "\bssn\b",
    "social[_-]?security",
    "credit[_-]?card",
    "card[_-]?number",
    "\bcvv\b",
  ].join("|"),
  "i",
);

/** Warned once per island and path, so a busy page does not repeat itself. */
const warnedSecrets = new Set<string>();

/**
 * Warn when island props look like they carry a secret.
 *
 * Everything an island receives is serialized into the page and sent to the
 * browser - that is what props are for. The failure is passing a whole record
 * when the island needed two fields of it: `<Profile user={user} />` ships the
 * password hash along with the name, and nothing about the page looks wrong.
 *
 * Nested, because that is where it actually happens. A top-level key called
 * `user` is unremarkable; `user.passwordHash` is the problem.
 *
 * Development only, and a warning rather than an error: this is a heuristic on
 * key names, and a heuristic must not be able to break a production render.
 */
function warnAboutSecretsInProps(island: string, props: Props): void {
  if (peekRenderContext()?.config.dev !== true) return;

  for (const path of findSecretPaths(props)) {
    const key = `${island}.${path}`;
    if (warnedSecrets.has(key)) continue;
    warnedSecrets.add(key);

    console.warn(
      `[stoneware] Island "${island}" receives ${path}, which looks like a secret.
` +
        `  Island props are serialized into the HTML and sent to the browser.
` +
        `  Pass only the fields the island needs, not the whole record.`,
    );
  }
}

const warnedInlineStyle = new Set<string>();

/**
 * A `style` attribute under a policy that will not run it.
 *
 * The default CSP is `style-src 'self'` with no `unsafe-inline`, and that
 * governs style *attributes*, not just `<style>` blocks. So the renderer emits
 * `style="..."` perfectly well and the browser refuses to apply it: the element
 * is there, the declaration is in the HTML, and nothing happens. No error, no
 * network failure - only a console entry most people never open.
 *
 * Warned rather than thrown, and only in development, for two reasons. The
 * policy is configurable, so a project that has widened it is doing nothing
 * wrong; and a heuristic about CSP must never be able to break a production
 * render. Once per tag, because a list of fifty rows would otherwise report the
 * same mistake fifty times.
 */
function warnAboutInlineStyle(tag: string): void {
  const config = peekRenderContext()?.config;
  if (config?.dev !== true) return;

  // `csp: false` removes the header entirely, and a policy the project wrote
  // itself may well permit inline styles. Only the case that actually breaks is
  // worth interrupting for.
  const csp = config.csp;
  if (csp === false) return;
  if (!/style-src/.test(csp) || /style-src[^;]*'unsafe-inline'/.test(csp)) return;

  if (warnedInlineStyle.has(tag)) return;
  warnedInlineStyle.add(tag);

  console.warn(
    `[stoneware] <${tag} style="..."> will be ignored by the browser.
` +
      `  The Content-Security-Policy sets style-src without 'unsafe-inline', which
` +
      `  blocks style attributes as well as <style> blocks. The markup renders, the
` +
      `  declaration is in the HTML, and it simply never applies.
` +
      `  Use a class and a .css file beside the component - the build collects it.
` +
      `  To allow inline styles instead, set csp in stoneware.config.ts.`,
  );
}

function findSecretPaths(value: unknown, prefix = "", depth = 0): string[] {
  // Deep enough for a realistic props object, shallow enough that a cyclic or
  // enormous structure cannot turn a dev render into a hang.
  if (depth > 6 || value === null || typeof value !== "object") return [];

  const found: string[] = [];

  if (Array.isArray(value)) {
    // One representative element: an array of 500 users would otherwise report
    // the same leak 500 times.
    if (value.length > 0) found.push(...findSecretPaths(value[0], `${prefix}[0]`, depth + 1));
    return found;
  }

  for (const [key, nested] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (SECRET_KEY.test(key)) found.push(path);
    else found.push(...findSecretPaths(nested, path, depth + 1));
  }

  return found;
}

/**
 * Island props cross the network as JSON, so they must survive the trip. Failing
 * here - at render time, naming the island - beats a confusing runtime error in
 * the browser.
 */
function assertSerializableProps(name: string, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (key === "children") {
      // Children are server-rendered into the initial HTML but cannot be
      // reconstructed on the client, where the island re-renders itself.
      throw new Error(
        `Island "${name}" was given children. Islands own their entire subtree; ` +
          `pass data as props instead.`,
      );
    }
    if (typeof value === "function") {
      throw new Error(
        `Island "${name}" received a function as prop "${key}". ` +
          `Island props must be JSON-serializable - define behavior inside the island itself.`,
      );
    }
  }

  try {
    safeJSONStringify(props);
  } catch (cause) {
    throw new Error(
      `Island "${name}" received props that cannot be serialized to JSON.`,
      { cause },
    );
  }
}

/**
 * Build the hydration payload for a rendered page.
 *
 * Emitted as `type="application/json"`, which browsers never execute, and
 * escaped so the payload cannot terminate the element. Nothing user-controlled
 * is ever concatenated into executable script source (CLAUDE.md §10).
 */
export function renderIslandPayload(
  islands: CollectedIsland[],
  chunks: Record<string, string> = {},
): string {
  if (islands.length === 0) return "";

  const data = {
    islands: islands.map(({ name, id, props, strategy, query }) => ({
      name,
      id,
      props,
      // Omitted for the common case, which keeps eager pages byte-identical to
      // what they were before directives existed.
      ...(strategy === "load" ? {} : { on: strategy }),
      ...(query === undefined ? {} : { q: query }),
    })),
    chunks,
  };

  return `<script type="application/json" id="stoneware-islands">${safeJSONStringify(data)}</script>`;
}
