/**
 * `notFound()` - answer 404 from inside a page that matched.
 *
 * `routes/_404.tsx` covers the case where no route matched at all. It cannot
 * cover the more common one: a route with `[params]` matches any slug, then
 * discovers the content does not exist. Without this a template can only render
 * "no such page" markup, which is served with a 200 - a soft 404 that search
 * engines index and that tells a client the request succeeded.
 *
 * Thrown rather than returned so it works from anywhere in the render, including
 * inside a helper several calls deep, without every intermediate function having
 * to know about it and pass it back up.
 */

const NOT_FOUND = Symbol.for("stoneware.notFound");

export interface NotFoundSignal {
  [NOT_FOUND]: true;
  message: string;
}

/**
 * Stop rendering and answer 404.
 *
 * ```tsx
 * export default function Post({ params }: PageProps) {
 *   const post = getPost(params.slug);
 *   if (!post) notFound();
 *   return <article>{post.title}</article>;
 * }
 * ```
 *
 * Returns `never`, so TypeScript narrows the value as present after the call -
 * no `!` and no redundant early return.
 */
export function notFound(message = "Not Found"): never {
  const signal: NotFoundSignal = { [NOT_FOUND]: true, message };
  throw signal;
}

/**
 * Is this thrown value a `notFound()` rather than a real failure?
 *
 * A branded object rather than an `Error` subclass: an error page or logger
 * that inspects thrown values should not have to tell a deliberate 404 apart
 * from a genuine crash by reading a message.
 */
export function isNotFound(value: unknown): value is NotFoundSignal {
  return typeof value === "object" && value !== null && NOT_FOUND in value;
}
