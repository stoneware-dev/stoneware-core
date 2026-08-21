/**
 * `<Boundary>` - one failing subtree instead of one failing page.
 *
 * Without it, a component that throws anywhere in a page loses the whole page:
 * the request unwinds to `routes/_500.tsx`, and a malformed row in one widget
 * costs the article around it. That is the wrong blast radius for a site whose
 * pages are mostly content.
 *
 * ```tsx
 * <Boundary fallback={<p>Reviews are unavailable right now.</p>}>
 *   <Reviews rows={rows} />
 * </Boundary>
 * ```
 *
 * Server-only, and that is not a limitation being apologised for: rendering is
 * a single synchronous walk to a string, so "catch it and render something
 * else" is a `try`/`catch` around one subtree and nothing more. There is no
 * error state to hold, nothing to reset, and no second pass.
 *
 * Inside an `islands/` component it degrades to nothing - the client runtime
 * calls it as an ordinary function and renders the children unguarded. Islands
 * are the one place code runs twice, and a boundary that caught on the server
 * and not in the browser would be worse than one that never claimed to.
 */

import { jsx } from "../jsx-runtime.ts";
import { Fragment } from "../render/types.ts";
import type { Child, VNode } from "../render/types.ts";

export interface BoundaryProps {
  /**
   * What to render instead when a child throws.
   *
   * As a function it receives the thrown value - but only in development. In
   * production `error` is `undefined`, the same contract `routes/_500.tsx`
   * already has and for the same reason: an exception message routinely carries
   * a file path, a query, or a connection string, and a fallback is rendered
   * into a page a visitor reads.
   */
  fallback: Child | ((props: { error?: unknown }) => Child);
  children?: Child;
}

/**
 * Recognised by the renderer by function identity, the way an island is.
 *
 * The body only runs if something calls it directly - a unit test, or the
 * client runtime inside an island. Rendering the children unguarded is the
 * right answer in both cases: no boundary, rather than a broken one.
 *
 * The children are wrapped in a fragment rather than returned bare so the
 * declared return type is `VNode`. `Child` includes `undefined`, which JSX will
 * not accept as an element type - and the error would land on the person
 * writing `<Boundary>` in their own project, not here.
 */
export function Boundary(props: BoundaryProps): VNode {
  return jsx(Fragment, { children: props.children });
}
