import type { ActionContext } from "../../../../src/router.ts";

export function GET({ locals }: ActionContext): Response {
  return Response.json({ user: (locals as Record<string, unknown>).user });
}
