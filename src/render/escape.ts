/**
 * Escaping primitives.
 *
 * The framework's stance (CLAUDE.md §10): escaping is not a function you
 * remember to call, it is what happens unless you go out of your way. The only
 * way to emit unescaped markup is `raw()`, which is deliberately verbose and
 * deliberately named.
 */

import { RAW } from "./types.ts";
import type { RawHTML } from "./types.ts";

/** Escape a string for HTML text and quoted-attribute contexts. */
export function escapeHTML(value: string): string {
  return Bun.escapeHTML(value);
}

/**
 * Mark a string as already-safe HTML so the renderer emits it verbatim.
 *
 * This bypasses the framework's only XSS defense. Never hand it a value that
 * originated from a request, a database, or any other untrusted source.
 */
export function raw(html: string): RawHTML {
  if (typeof html !== "string") {
    throw new TypeError(`raw() expects a string, received ${typeof html}`);
  }
  return { [RAW]: true, value: html };
}

// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are built from char
// codes rather than written literally: as literal characters they would be
// line terminators in this source file, and TypeScript rejects them inside a
// regex literal.
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

const JSON_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  [LINE_SEP]: "\\u2028",
  [PARA_SEP]: "\\u2029",
};

const JSON_UNSAFE = new RegExp(`[<>&${LINE_SEP}${PARA_SEP}]`, "g");

/**
 * Serialize a value to JSON that is safe to embed inside an HTML document.
 *
 * `<` and `>` are escaped so a payload can never terminate the containing
 * element (`</script>`), and U+2028/U+2029 are escaped because they are literal
 * line terminators in JavaScript source but legal raw characters in JSON.
 *
 * This is what island props travel through - hydration payloads are serialized
 * and escaped, never concatenated into markup (CLAUDE.md §10).
 */
export function safeJSONStringify(value: unknown): string {
  const json = JSON.stringify(value);
  // `undefined` and functions stringify to `undefined`, which is not valid JSON.
  if (json === undefined) return "null";
  return json.replace(JSON_UNSAFE, (ch) => JSON_ESCAPES[ch]!);
}
