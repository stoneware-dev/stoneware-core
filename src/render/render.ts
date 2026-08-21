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
  isSignalLike,
  unsafeURLReason,
} from "./attributes.ts";
import { noteCaught, peekRenderContext } from "../http/context.ts";
import { escapeHTML, safeJSONStringify } from "./escape.ts";
import { Boundary } from "../helpers/boundary.tsx";
import { isNotFound } from "../helpers/not-found.ts";
import { Fragment, isRaw, isVNode } from "./types.ts";
import type { BoundaryProps } from "../helpers/boundary.tsx";
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
  /**
   * The element currently being rendered into, for error attribution.
   *
   * Maintained by save-and-restore around each element's children rather than
   * by catching, because elements outnumber components heavily and a try/catch
   * on each one measured 38% of a full page render.
   */
  tag: string | null;
  /**
   * Whether to watch for signals that carry state between requests.
   *
   * Resolved once per render rather than per signal: the answer comes from
   * `AsyncLocalStorage`, and reading that for every signal on a page would put
   * a real cost on production for a check production never performs.
   */
  watchSharedSignals: boolean;
}

/** Render a tree to HTML, collecting any islands encountered along the way. */
export function renderToString(child: Child, options: RenderOptions = {}): RenderResult {
  const ctx: Context = {
    islands: options.islands ?? new Map(),
    collected: [],
    nextId: 0,
    tag: null,
    // Only inside a dev server request. A bare renderToString - a test, a
    // fragment rendered by hand - has no request context and nothing to
    // compare against, so it never reports.
    watchSharedSignals: peekRenderContext()?.config.dev === true,
  };
  // The path has finished assembling by the time it reaches here, so this is
  // where it gets folded into the message.
  let html: string;
  try {
    html = renderChild(child, ctx);
  } catch (error) {
    throw finalizeRenderError(error);
  }

  return { html, islands: ctx.collected };
}

/* -------------------------------------------------------------------------- */
/* Cross-request state detection (development only)                            */
/* -------------------------------------------------------------------------- */

/**
 * Signals that carry a visitor's data into the next visitor's page.
 *
 * A signal declared at module scope is one instance per *process* on the
 * server, shared by every request that process ever answers. Reading one during
 * a render is fine and is how islands share state. Writing one is a cross-user
 * data leak, and it is silent: the page renders, the types check, the tests
 * pass, and the status is 200. Reproduced on a two-route fixture, a request
 * carrying no parameters at all was served the previous visitor's identity and
 * basket, and two concurrent requests each rendered the other's data.
 *
 * Detection is by comparison rather than by interception. Nothing here wraps
 * `signal()` - `stoneware/signals` is a thin pass-through by design (CLAUDE.md
 * §2.3) and wrapping it would put this code in every island's client bundle.
 * Instead the renderer remembers what each signal held last time it rendered
 * one, and says something when that changes underneath it.
 *
 * What it cannot see: a signal mutated during a render but never rendered. The
 * leak is only observable here if the value reaches the output.
 */
let lastRenderedValue = new WeakMap<object, unknown>();

/** Signals already reported, so one mistake produces one message. */
let reportedSignals = new WeakSet<object>();

/**
 * Discard everything observed so far.
 *
 * Exists for tests, which need each case to start from nothing. There is no way
 * to clear a WeakMap, so both are replaced.
 */
export function resetSharedSignalWatch(): void {
  lastRenderedValue = new WeakMap();
  reportedSignals = new WeakSet();
}

function noteRenderedSignal(signal: object, value: unknown, tag: string | null): void {
  const seenBefore = lastRenderedValue.has(signal);
  const previous = lastRenderedValue.get(signal);
  lastRenderedValue.set(signal, value);

  // A signal created fresh inside a component has no history and never will,
  // because the next render creates a different object.
  if (!seenBefore) return;
  if (Object.is(previous, value)) return;
  if (reportedSignals.has(signal)) return;

  reportedSignals.add(signal);

  const where = tag === null ? "" : ` rendered inside <${tag}>`;
  console.warn(
    `[stoneware] A signal${where} changed value between renders: ` +
      `${summarizeValue(previous)} -> ${summarizeValue(value)}.\n` +
      `  A signal declared at module scope is one instance per server process, shared by every\n` +
      `  request it answers, so a value written during one render is still there for the next\n` +
      `  visitor. If this value differs per visitor, pass it to the island as a prop instead —\n` +
      `  props belong to one response and cannot outlive it.\n` +
      `  Reported once per signal, in development only.`,
  );
}

/** Short, safe rendering of a signal's value for the message. */
function summarizeValue(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 40 ? `"${value.slice(0, 40)}…"` : `"${value}"`;
  }
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") return Array.isArray(value) ? `[…${value.length}]` : "{…}";
  return String(value);
}

/* -------------------------------------------------------------------------- */
/* Error attribution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Which components a render error passed through on its way out.
 *
 * The renderer is a depth-first walk, so by the time an unsupported value is
 * discovered the only thing on the stack is the renderer itself: `renderChild`
 * called by `renderElement` called by `renderChild`, over and over. That names
 * the mechanism and not one line of the project's own code, which is the
 * opposite of what a stack trace is for.
 *
 * The walk *does* know, though - it just knows it on the way in, and the error
 * happens on the way out. So each component and element frame catches, records
 * its own name, and rethrows. The path assembles itself as the error unwinds,
 * costs nothing when nothing throws, and needs no bookkeeping on the hot path.
 */
const RENDER_ERROR = Symbol.for("stoneware.renderError");
const COMPONENT_PATH = Symbol.for("stoneware.componentPath");

interface RenderErrorParts {
  /** First line: what went wrong. */
  headline: string;
  /** Everything after the path: what to do about it. */
  detail: string;
}

type Annotated = {
  [RENDER_ERROR]?: RenderErrorParts;
  [COMPONENT_PATH]?: string[];
};

/**
 * A render error the framework raised itself.
 *
 * Held as parts rather than a finished string because the path belongs between
 * them, and the path is not known until the error has finished unwinding.
 */
function renderError(parts: RenderErrorParts): TypeError {
  const error = new TypeError(`${parts.headline}\n\n${parts.detail}`);

  // Drop this factory from the trace. Without it the first frame - and the
  // source excerpt printed above it - is the line inside render.ts that
  // constructs the error, which is the least informative line in the whole
  // stack and sits exactly where someone looks first.
  Error.captureStackTrace?.(error, renderError);

  Object.defineProperty(error, RENDER_ERROR, {
    value: parts,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return error;
}

/** Record one frame. Anything not an object - a thrown string - is left alone. */
function noteFrame(error: unknown, frame: string): void {
  if (typeof error !== "object" || error === null) return;
  const annotated = error as Annotated;

  let path = annotated[COMPONENT_PATH];
  if (path === undefined) {
    path = [];
    // Non-enumerable, or every console.error that prints this error also prints
    // `stoneware.componentPath: [ "<span>", ... ]` after the stack - the same
    // information a second time, as noise, in the one place someone is already
    // reading carefully.
    Object.defineProperty(error, COMPONENT_PATH, {
      value: path,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  // Capped: a deep tree would otherwise append a hundred frames, and the ones
  // that identify the problem are the innermost few.
  if (path.length < MAX_PATH_FRAMES) path.push(frame);
}

const MAX_PATH_FRAMES = 12;

/**
 * The components an error passed through, innermost first.
 *
 * Exported so the request pipeline can report it for *any* error, not only the
 * framework's own: a database driver that throws inside a template gets the
 * same "which component" answer, without its message being rewritten.
 */
export function componentPathOf(error: unknown): string[] | null {
  if (typeof error !== "object" || error === null) return null;
  const path = (error as Annotated)[COMPONENT_PATH];
  return path && path.length > 0 ? path : null;
}

/** Render the collected path as indented `in <X>` lines. */
export function formatComponentPath(path: string[]): string {
  const lines = path.map((frame) => `  in ${frame}`);
  if (path.length >= MAX_PATH_FRAMES) lines.push("  in ... (outer frames omitted)");
  return lines.join("\n");
}

/**
 * Fold the collected path into the message, once.
 *
 * Only for errors the framework raised. A thrown value from project code keeps
 * its own message exactly as written - the path is still attached, and the
 * server logs it separately.
 */
export function finalizeRenderError(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return error;

  const annotated = error as Annotated;
  const parts = annotated[RENDER_ERROR];
  if (parts === undefined) return error;

  // Cleared first, so an error that passes through two renders - a boundary
  // fallback that rethrows, say - is not annotated twice.
  delete annotated[RENDER_ERROR];

  const path = annotated[COMPONENT_PATH];
  if (path === undefined || path.length === 0) return error;

  (error as { message: string }).message =
    `${parts.headline}\n\n${formatComponentPath(path)}\n\n${parts.detail}`;
  return error;
}

/**
 * What the unsupported value actually was.
 *
 * "Cannot render value of type object" is true of a Date, a database row, a
 * Map, and a class instance, and the fix is different for each. Keys are named
 * rather than values printed: `{ id, title, price }` is enough to recognise a
 * product row, while dumping the values would put whatever the row holds into
 * a log line.
 */
function describeValue(value: object): string {
  if (value instanceof Date) {
    return "a Date. Format it first - {date.toISOString()} or your own helper";
  }
  if (value instanceof Map || value instanceof Set) {
    return `a ${value.constructor.name} of size ${value.size}. Render [...value] instead`;
  }
  if (value instanceof Promise) {
    return "a Promise. Only a route's default export may be async";
  }

  const name = value.constructor?.name;
  if (name !== undefined && name !== "Object") {
    return `an instance of ${name}. Render the fields you want, not the object`;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) return "a plain object with no keys";

  const shown = keys.slice(0, 8).join(", ");
  const rest = keys.length > 8 ? `, ... (${keys.length} keys)` : "";
  return `a plain object with keys: ${shown}${rest}`;
}

function renderChild(child: Child, ctx: Context): string {
  // Booleans render as nothing so `{cond && <p/>}` works as expected.
  if (child == null || typeof child === "boolean") return "";

  if (typeof child === "string") return escapeHTML(child);
  if (typeof child === "number" || typeof child === "bigint") return escapeHTML(String(child));

  if (isRaw(child)) return child.value;

  // A signal renders its current value. On the server that is a one-time read;
  // the reactive binding is established later, in the browser.
  if (child instanceof Signal || isSignalLike(child)) {
    const value = (child as { value: Child }).value;
    if (ctx.watchSharedSignals) noteRenderedSignal(child as object, value, ctx.tag);
    return renderChild(value, ctx);
  }

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
    throw renderError({
      headline: "A component returned a promise while rendering.",
      detail:
        `Only a route's default export may be async - the server awaits that one ` +
        `call before rendering begins. A component nested inside JSX cannot be, ` +
        `because rendering never awaits.\n\n` +
        `Fetch in the route and pass the result down as props.`,
    });
  }

  // A React element got here, which means JSX was compiled against React's
  // runtime rather than Stoneware's. Naming that beats "cannot render value of
  // type object", which sends people looking at their data.
  if (isReactElement(child)) {
    throw renderError({
      headline: "This JSX was compiled with React's runtime, not Stoneware's.",
      detail:
        `Set the compiler options in tsconfig.json:\n\n` +
        `  "jsx": "react-jsx",\n` +
        `  "jsxImportSource": "stoneware"\n\n` +
        `A project created with create-stoneware has these already; a file outside ` +
        `the project's tsconfig, or an editor using a different one, is the usual cause.`,
    });
  }

  // Naming what the value *was* is most of the fix. "type object" is equally
  // true of a Date, a database row and a Map, and each needs something
  // different done to it.
  const what = typeof child === "object" ? describeValue(child as object) : `of type ${typeof child}`;

  const error = renderError({
    headline: `Cannot render ${what}.`,
    detail:
      `Templates may return elements, strings, numbers, arrays, signals, or null.\n` +
      `An object has to become markup or text first - {product.title}, not {product}.`,
  });

  // The element the value was interpolated into is the most specific frame
  // there is, and it is already known - no per-element bookkeeping required.
  if (ctx.tag !== null) noteFrame(error, `<${ctx.tag}>`);
  throw error;
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
    // Before the island lookup, because a boundary is the renderer's own and
    // could never be one.
    if (type === Boundary) return renderBoundary(props as unknown as BoundaryProps, ctx);

    const islandName = ctx.islands.get(type);
    if (islandName !== undefined) return renderIsland(islandName, type, props, ctx);

    // A plain template function: called once, on the server, per request.
    //
    // The catch is what turns "somewhere in render.ts" into "in <ProductCard>".
    // It costs nothing while nothing throws, and the frame it adds is the one
    // piece of information the stack trace cannot supply - the renderer's own
    // frames are all identical.
    try {
      return renderChild(type(props), ctx);
    } catch (error) {
      noteFrame(error, `<${type.name || "anonymous component"}>`);
      throw error;
    }
  }

  if (typeof type !== "string") {
    throw new TypeError(`Invalid element type: ${String(type)}`);
  }

  return renderElement(type, props, ctx);
}

/**
 * Render a `<Boundary>`: the children, or the fallback if they throw.
 *
 * Two things have to be undone before the fallback renders, and both are the
 * kind that would go unnoticed.
 *
 * A child that registered an island before throwing left an entry in
 * `ctx.collected`. Its markup is being discarded, so the hydration payload
 * would name an island with no element on the page - the client would look for
 * a marker that is not there. Truncating restores the count, and island ids are
 * positional, so the next island reuses the index rather than colliding.
 *
 * The same for `<link rel="preload">` tags contributed from inside the subtree:
 * a preload for an image that is no longer on the page is a wasted request.
 *
 * `notFound()` is deliberately not caught. It is a routing decision travelling
 * as an exception, and swallowing it would render a fallback with a 200 - a
 * soft 404, which is the exact bug 0.1.3 removed.
 */
function renderBoundary(props: BoundaryProps, ctx: Context): string {
  const context = peekRenderContext();
  const islandCount = ctx.collected.length;
  const preloads = context === null ? null : [...context.preloads];

  try {
    return renderChild(props.children, ctx);
  } catch (error) {
    if (isNotFound(error)) throw error;

    ctx.collected.length = islandCount;
    if (context !== null && preloads !== null) {
      context.preloads.clear();
      for (const tag of preloads) context.preloads.add(tag);
    }

    // Finalized here too: a boundary is a second exit from the walk, and its
    // console line is the only place this error is ever seen.
    reportCaught(finalizeRenderError(error));

    // If the fallback throws too there is nothing sensible left to do, so it
    // propagates: the route's _500 page handles it, and the stack points at the
    // fallback rather than at the child that started this.
    const { fallback } = props;
    return renderChild(
      typeof fallback === "function"
        ? fallback({ error: context?.config.dev === true ? error : undefined })
        : fallback,
      ctx,
    );
  }
}

/**
 * An absorbed error still has to be visible.
 *
 * The console, always: with no `observe` hook configured - the production
 * default - it is the only thing standing between a caught error and complete
 * silence. A widget that fails on every request is supposed to be noisy.
 *
 * And onto the render context, so the request's `observe` event carries it and
 * a reporting backend gets the thrown value rather than a formatted line.
 */
function reportCaught(error: unknown): void {
  noteCaught(error);
  console.error("[stoneware] <Boundary> caught an error and rendered its fallback:", error);
}

/* -------------------------------------------------------------------------- */
/* Classification caches                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Tag and attribute names are a tiny fixed vocabulary, asked about constantly.
 *
 * A page is a few thousand elements, drawn from perhaps thirty tag names and
 * fifty attribute names. Every one of them was being re-derived on every
 * occurrence: a regex over the name, a `toLowerCase()` allocation, two Set
 * lookups per element; two regexes, a `startsWith` and an alias lookup per
 * attribute. Measured on a 58 kB page, that constant work was roughly half the
 * render - and none of it can change for a given name.
 *
 * Bounded, because a name is not guaranteed to come from source. A component
 * spreading keys derived from request data could otherwise grow these without
 * limit. Past the cap the answer is still correct, just recomputed.
 */
const MAX_CACHED_NAMES = 4096;

// Plain constants rather than a `const enum`: this package ships TypeScript
// source, and a `const enum` only inlines reliably for a compiler that sees the
// whole program. Nothing here crosses a module boundary, so the enum bought
// nothing that a number does not.
const TAG_INVALID = 0;
const TAG_NORMAL = 1;
const TAG_VOID = 2;
const TAG_RAW_TEXT = 3;

type TagClass = typeof TAG_INVALID | typeof TAG_NORMAL | typeof TAG_VOID | typeof TAG_RAW_TEXT;

const tagClasses = new Map<string, TagClass>();

function classifyTag(tag: string): TagClass {
  const cached = tagClasses.get(tag);
  if (cached !== undefined) return cached;

  let computed: TagClass;
  if (!VALID_ATTRIBUTE_NAME.test(tag)) {
    computed = TAG_INVALID;
  } else {
    const lower = tag.toLowerCase();
    computed = VOID_ELEMENTS.has(lower)
      ? TAG_VOID
      : RAW_TEXT_ELEMENTS.has(lower)
        ? TAG_RAW_TEXT
        : TAG_NORMAL;
  }

  if (tagClasses.size < MAX_CACHED_NAMES) tagClasses.set(tag, computed);
  return computed;
}

/**
 * What a prop name resolves to: the attribute to emit, or why it emits nothing.
 *
 * Symbols rather than a wrapper object so the cached value needs no allocation
 * and the common case is a plain string.
 */
const SKIP_ATTRIBUTE = null;
const DIRECTIVE_ATTRIBUTE = Symbol("stoneware.directive");
const INVALID_ATTRIBUTE = Symbol("stoneware.invalid");

type AttributeClass = string | null | typeof DIRECTIVE_ATTRIBUTE | typeof INVALID_ATTRIBUTE;

const attributeClasses = new Map<string, AttributeClass>();

/**
 * Order is preserved exactly as it was written out: `children`/`key`/`ref` and
 * `dangerouslySetInnerHTML` first, then event handlers, then directives, then
 * validity. An event handler with an otherwise invalid name is still skipped
 * rather than rejected, because that is what it did before.
 */
function computeAttributeClass(name: string): AttributeClass {
  if (name === "children" || name === "key" || name === "ref") return SKIP_ATTRIBUTE;
  if (name === "dangerouslySetInnerHTML") return SKIP_ATTRIBUTE;
  // Event handlers only mean something once an island is hydrated.
  if (EVENT_HANDLER.test(name)) return SKIP_ATTRIBUTE;
  if (name.startsWith(DIRECTIVE_PREFIX)) return DIRECTIVE_ATTRIBUTE;

  const attribute = ATTRIBUTE_ALIASES[name] ?? name;
  return VALID_ATTRIBUTE_NAME.test(attribute) ? attribute : INVALID_ATTRIBUTE;
}

function classifyAttribute(name: string): AttributeClass {
  const cached = attributeClasses.get(name);
  if (cached !== undefined) return cached;

  const computed = computeAttributeClass(name);
  if (attributeClasses.size < MAX_CACHED_NAMES) attributeClasses.set(name, computed);
  return computed;
}

function renderElement(tag: string, props: Props, ctx: Context): string {
  const tagClass = classifyTag(tag);
  if (tagClass === TAG_INVALID) {
    throw new Error(`Invalid element name: ${JSON.stringify(tag)}`);
  }

  let html = `<${tag}${renderAttributes(props, tag)}>`;

  if (tagClass === TAG_VOID) {
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
  } else if (tagClass === TAG_RAW_TEXT) {
    html += renderRawTextContent(tag, props.children as Child);
  } else {
    // The innermost element, recorded by two field writes rather than by a
    // try/catch. Elements outnumber components by an order of magnitude, and
    // wrapping each one cost 38% of a full page render - measured, after the
    // first attempt did exactly that. Save-and-restore is free by comparison.
    //
    // No `finally` on the restore, deliberately: the value is read at the
    // moment of the throw, before any unwinding, so it is already correct - and
    // a render that threw discards its context anyway.
    const enclosing = ctx.tag;
    ctx.tag = tag;
    html += renderChild(props.children as Child, ctx);
    ctx.tag = enclosing;
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
    const classified = classifyAttribute(name);
    if (classified === SKIP_ATTRIBUTE) continue;

    if (typeof classified !== "string") {
      // A directive here has reached a plain element rather than an island, so
      // nothing would ever act on it. Silently rendering it as an attribute is
      // the worst outcome: the page looks correct and never hydrates lazily.
      if (classified === DIRECTIVE_ATTRIBUTE) {
        throw new Error(
          `<${tag}> has a hydration directive ${JSON.stringify(name)}, but only islands hydrate. ` +
            `Move the directive to the island component itself.`,
        );
      }
      throw new Error(`Invalid attribute name ${JSON.stringify(name)} on <${tag}>.`);
    }

    const attribute = classified;
    let value = props[name];
    if (value instanceof Signal || isSignalLike(value)) {
      value = (value as { value: unknown }).value;
    }

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
