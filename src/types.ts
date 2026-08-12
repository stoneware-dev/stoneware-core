/**
 * Core value types shared by the server renderer and the client runtime.
 *
 * Keep this module dependency-free (other than signals' type) - it is imported
 * by both the Bun-target server bundle and the browser-target island bundles.
 */

import type { Signal } from "@preact/signals-core";

/** Brand identifying an object produced by the JSX runtime. */
export const VNODE = Symbol.for("stoneware.vnode");

/** Brand identifying pre-trusted HTML produced by `raw()`. */
export const RAW = Symbol.for("stoneware.raw");

/** `<>...</>` - renders children with no surrounding element. */
export const Fragment = Symbol.for("stoneware.fragment");

export interface RawHTML {
  readonly [RAW]: true;
  readonly value: string;
}

export type Props = Record<string, unknown> & { children?: Child };

/**
 * Templates are plain functions: props in, markup out. No classes, no hooks,
 * no lifecycle - see CLAUDE.md §2.2.
 */
export type Component<P = Props> = (props: P) => Child;

export type ElementType = string | Component<any> | typeof Fragment;

export interface VNode {
  readonly [VNODE]: true;
  readonly type: ElementType;
  readonly props: Props;
  readonly key: string | number | null;
}

export type Child =
  | VNode
  | RawHTML
  | Signal<any>
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Child[];

export function isVNode(value: unknown): value is VNode {
  return typeof value === "object" && value !== null && (value as any)[VNODE] === true;
}

export function isRaw(value: unknown): value is RawHTML {
  return typeof value === "object" && value !== null && (value as any)[RAW] === true;
}
