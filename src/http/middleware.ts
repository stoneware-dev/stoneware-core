/**
 * `routes/_middleware.ts` - code that runs on every request.
 *
 * Where it sits in the pipeline is the whole design:
 *
 *   static assets -> CSRF verification -> middleware -> route match -> handler
 *
 * After CSRF, never before. Middleware is ordinary project code, and code that
 * ran ahead of verification could act on a request that was about to be
 * rejected - which is how a framework ends up with a documented way around its
 * own protection. Running after means middleware cannot weaken the guarantee no
 * matter what it does.
 *
 * Before route matching, so it also sees requests that are about to 404. A
 * redirect rule for a moved page is worth nothing if it only runs for paths
 * that already resolve.
 */

/**
 * Per-request storage, shared between middleware and whatever handles the
 * request.
 *
 * Empty on purpose. Declare what your project puts here and it is typed
 * everywhere:
 *
 * ```ts
 * declare module "stoneware" {
 *   interface Locals {
 *     user?: { id: string; name: string };
 *   }
 * }
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Locals {}

export interface MiddlewareContext {
  request: Request;
  /** The public URL, with any trusted proxy headers already applied. */
  url: URL;
  /** Values passed to the route. The same object the handler receives. */
  locals: Locals;
}

/**
 * Return a `Response` to answer the request here and stop; return nothing to
 * carry on to the route.
 *
 * There is deliberately no `next()` and no way to wrap the response. Security
 * headers are applied at a single exit point, and a middleware that could
 * rewrite the finished response could remove them.
 */
export type Middleware = (
  context: MiddlewareContext,
) => Response | undefined | void | Promise<Response | undefined | void>;
