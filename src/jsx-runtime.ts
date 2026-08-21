/**
 * Stoneware's JSX runtime.
 *
 * Bun's native TSX transpilation does the parsing; this module only builds the
 * plain data structure it hands back. There is no VDOM here and no reconciler -
 * a VNode is an inert `{ type, props }` record that `renderToString` walks once
 * per request (CLAUDE.md §6).
 *
 * Both calling conventions are supported: the automatic runtime (`jsx`/`jsxs`,
 * children arriving inside props) and the classic one (`h`, children as rest
 * arguments), so hand-written `h()` calls and transpiled TSX interoperate.
 */

import { VNODE, Fragment } from "./render/types.ts";
import type { Child, ElementType, Props, VNode } from "./render/types.ts";

export { Fragment };

function createVNode(type: ElementType, props: Props, key: string | number | null): VNode {
  return { [VNODE]: true, type, props, key };
}

/** Automatic-runtime entry point for elements with 0 or 1 children. */
export function jsx(type: ElementType, props: Props, key?: string | number): VNode {
  return createVNode(type, props ?? {}, key ?? null);
}

/** Automatic-runtime entry point for elements with static multiple children. */
export const jsxs = jsx;

/** Development entry point. Stoneware does not vary behavior by mode here. */
export function jsxDEV(type: ElementType, props: Props, key?: string | number): VNode {
  return createVNode(type, props ?? {}, key ?? null);
}

/** Classic-runtime factory, for callers writing `h(...)` directly. */
export function h(type: ElementType, props?: Props | null, ...children: Child[]): VNode {
  const merged: Props = { ...(props ?? {}) };
  const { key, ...rest } = merged as Props & { key?: string | number };

  if (children.length === 1) rest.children = children[0];
  else if (children.length > 1) rest.children = children;

  return createVNode(type, rest, key ?? null);
}

/* -------------------------------------------------------------------------- */
/* JSX types                                                                   */
/* -------------------------------------------------------------------------- */

type Falsy = false | null | undefined;

/**
 * Attribute values are intentionally permissive: a `Signal` is legal in an
 * island (it binds reactively on the client) and renders as its current value
 * on the server.
 */
type AttrValue = string | number | boolean | bigint | Falsy | object;

interface StonewareIntrinsicAttributes {
  key?: string | number;
  children?: Child;
  class?: AttrValue;
  className?: AttrValue;
  style?: string | Record<string, string | number> | object;
  /** Escape hatch mirroring `raw()`, for the rare trusted-HTML element. */
  dangerouslySetInnerHTML?: { __html: string };
  [attribute: string]: unknown;
}

export namespace JSX {
  export type Element = VNode;

  export interface ElementChildrenAttribute {
    children: object;
  }

  /**
   * Props accepted by every component, on top of its own.
   *
   * The hydration directives live here because TypeScript cannot tell an island
   * from any other function: an island is one by virtue of living in
   * `islands/`, which is a fact about the filesystem, not about the type. So
   * the directives type-check anywhere a component is used, and the renderer is
   * what rejects them on something that will never hydrate.
   */
  export interface IntrinsicAttributes {
    key?: string | number;
    /** Hydrate as soon as the island's chunk loads. The default. */
    "client:load"?: boolean;
    /** Hydrate when the island scrolls into view. */
    "client:visible"?: boolean;
    /** Hydrate when the browser next goes idle. */
    "client:idle"?: boolean;
    /** Hydrate when a media query matches, e.g. "(min-width: 60rem)". */
    "client:media"?: string;
  }

  export interface IntrinsicElements {
    [tagName: string]: StonewareIntrinsicAttributes;
  }
}
