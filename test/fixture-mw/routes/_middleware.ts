import type { MiddlewareContext } from "../../../src/middleware.ts";

/** Exercises all three things middleware can do. */
export default function middleware({ url, locals }: MiddlewareContext) {
  // 1. Short-circuit.
  if (url.pathname === "/blocked") {
    return new Response("blocked by middleware", { status: 403 });
  }

  // 2. Redirect, including for a path that has no route at all.
  if (url.pathname === "/old") {
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }

  // 3. Pass values to the route.
  (locals as Record<string, unknown>).user = url.searchParams.get("as") ?? "anonymous";
}
