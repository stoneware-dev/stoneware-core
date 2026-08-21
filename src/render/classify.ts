/**
 * What a tag or attribute name means, decided once per distinct name.
 *
 * A page is a few thousand elements drawn from perhaps thirty tag names and
 * fifty attribute names, and every one of them used to be re-derived on every
 * occurrence: a regex, a `toLowerCase()` allocation and two Set lookups per
 * element, two regexes and an alias lookup per attribute. On a 58 kB page that
 * constant work was roughly half the render, and none of it can change for a
 * given name.
 *
 * Everything here is a pure function of a string, which is what lets it sit
 * below the walk rather than inside it — this module imports nothing from
 * render.ts, so there is no cycle to reason about.
 */

import {
  ATTRIBUTE_ALIASES,
  EVENT_HANDLER,
  VALID_ATTRIBUTE_NAME,
} from "./attributes.ts";

/** The directive prefix, here because the attribute classifier is what reads it. */
export const DIRECTIVE_PREFIX = "client:";

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
export const TAG_INVALID = 0;
export const TAG_NORMAL = 1;
export const TAG_VOID = 2;
export const TAG_RAW_TEXT = 3;

export type TagClass = typeof TAG_INVALID | typeof TAG_NORMAL | typeof TAG_VOID | typeof TAG_RAW_TEXT;

const tagClasses = new Map<string, TagClass>();

export function classifyTag(tag: string): TagClass {
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
export const SKIP_ATTRIBUTE = null;
export const DIRECTIVE_ATTRIBUTE = Symbol("stoneware.directive");
export const INVALID_ATTRIBUTE = Symbol("stoneware.invalid");

export type AttributeClass = string | null | typeof DIRECTIVE_ATTRIBUTE | typeof INVALID_ATTRIBUTE;

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

export function classifyAttribute(name: string): AttributeClass {
  const cached = attributeClasses.get(name);
  if (cached !== undefined) return cached;

  const computed = computeAttributeClass(name);
  if (attributeClasses.size < MAX_CACHED_NAMES) attributeClasses.set(name, computed);
  return computed;
}
