/**
 * What an attribute is allowed to be.
 *
 * One module, imported by both renderers. The server builds a string and the
 * client builds DOM nodes, but the question "is this attribute safe" has one
 * answer, and it used to be answered twice.
 *
 * That duplication was not theoretical: the handler pattern was tightened in
 * the renderer and left alone in the client, so for a while an island was
 * checked on first paint and unchecked on every update afterwards. Same code,
 * different safety, depending on whether a signal had fired yet.
 *
 * Nothing here imports anything. It ships to the browser as part of the island
 * runtime, so it stays small and free of server-only code.
 */

/**
 * Event-handler attributes, in any casing.
 *
 * Case-insensitive deliberately. `on[A-Z]` matches the camelCase form an author
 * writes by hand and misses the lowercase form that arrives from a spread of
 * untrusted keys - which is exactly how `<div onclick="alert(1)">` reached the
 * output. HTML reserves the whole `on*` prefix for handlers, so treating it as
 * reserved costs nothing real; `data-*` is the escape hatch.
 */
export const EVENT_HANDLER = /^on[a-z]/i;

/** Rejects a name that could break out of the tag it is written into. */
export const VALID_ATTRIBUTE_NAME = /^[a-zA-Z_:][\w.:-]*$/;

export const ATTRIBUTE_ALIASES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
};

/**
 * Attributes whose value the browser fetches or navigates to.
 *
 * Escaping cannot make `javascript:` safe - the value is syntactically valid
 * and still executes - so these are checked for scheme rather than only escaped.
 */
const URL_ATTRIBUTES = new Set([
  "href", "src", "action", "formaction", "poster", "data", "ping", "cite", "xlink:href",
]);

/** Whitespace and C0 controls, which browsers ignore inside a scheme. */
const CONTROL_AND_SPACE = /[\u0000-\u0020]/g;

/** The subset the browser navigates to, where a `data:` document also runs. */
const NAVIGABLE_ATTRIBUTES = new Set(["href", "action", "formaction", "ping"]);

/**
 * Why this attribute value is unsafe, or null when it is fine.
 *
 * Returns a reason rather than throwing so each caller can fail in the way that
 * suits it: the server aborts the render, the client declines to set the
 * attribute. Throwing on the client would take out the whole island for a value
 * that arrived after hydration - a dead link is a better outcome than a dead
 * page.
 */
export function unsafeURLReason(attribute: string, value: string): string | null {
  if (!URL_ATTRIBUTES.has(attribute)) return null;

  // Browsers ignore whitespace and control characters inside a scheme, so
  // `java\tscript:` and ` JaVaScRiPt:` both run. Strip before comparing.
  const scheme = value.replace(CONTROL_AND_SPACE, "").toLowerCase();

  if (scheme.startsWith("javascript:")) return "javascript:";
  if (scheme.startsWith("vbscript:")) return "vbscript:";

  // `data:` is refused only where the browser would navigate to it. A
  // `data:image/png;base64,...` in `<img src>` is ordinary, and the default CSP
  // already permits it.
  if (NAVIGABLE_ATTRIBUTES.has(attribute) && scheme.startsWith("data:")) return "data:";

  return null;
}
