import type { ActionContext } from "../../../../src/routing/router.ts";

/** GET so it reaches the handler: a POST would be stopped by CSRF first. */
export function GET(_context: ActionContext): Response {
  throw new Error("api handler exploded");
}
