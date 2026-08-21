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
 *
 * Synchronous, and that is load-bearing rather than incidental: rendering walks
 * the tree to a string in one pass with no await anywhere, so a component nested
 * inside JSX has no point at which a promise could be resolved. Islands are
 * bound by the same rule from the other side - they run in the browser too.
 */
export type Component<P = Props> = (props: P) => Child;

/**
 * A component the framework calls directly rather than finding inside a tree:
 * the default export of a route, and of `_404` / `_500`.
 *
 * These may be async. The server awaits the call before rendering begins, which
 * is the one place a promise can be resolved without a second rendering pass, so
 * it is the one place the type allows it:
 *
 * ```tsx
 * export default async function Post({ params }: PageProps) {
 *   const row = db.query("select * from posts where slug = ?").get(params.slug);
 *   if (!row) notFound();
 *   return <article>{row.title}</article>;
 * }
 * ```
 *
 * Anything deeper has to have finished its work before it returns markup - fetch
 * in the route, pass the result down as props.
 */
export type PageComponent<P = Props> = (props: P) => Child | Promise<Child>;

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
