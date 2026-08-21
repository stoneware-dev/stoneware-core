/** A non-HTML GET route, for the export content-type branch. */
import type { ActionContext } from "../../../src/routing/router.ts";

export function GET(_context: ActionContext): Response {
  return new Response(`<?xml version="1.0"?>\n<feed><title>fixture</title></feed>\n`, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
}
