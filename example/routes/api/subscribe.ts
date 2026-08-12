/**
 * A server action.
 *
 * By the time this runs, the framework has already verified the CSRF token —
 * there is no check to write here and no way to forget one (CLAUDE.md §9).
 */

import type { ActionContext } from "kiln";

const subscribers = new Set<string>();

export async function POST({ request }: ActionContext): Promise<Response> {
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();

  const wantsJSON = request.headers.get("accept")?.includes("application/json");

  if (!isPlausibleEmail(email)) {
    return respond(wantsJSON, 422, { ok: false, error: "That doesn't look like an email address." });
  }

  subscribers.add(email.toLowerCase());

  return respond(wantsJSON, 200, { ok: true, count: subscribers.size });
}

function isPlausibleEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/**
 * The island posts with `Accept: application/json`; a browser submitting the
 * form without JavaScript gets a redirect instead, so the no-JS path ends on a
 * real page rather than a wall of JSON.
 */
function respond(wantsJSON: boolean | undefined, status: number, body: Record<string, unknown>) {
  if (wantsJSON) {
    return Response.json(body, { status });
  }
  const outcome = body.ok ? "subscribed" : "error";
  return new Response(null, {
    status: 303,
    headers: { Location: `/?subscribe=${outcome}` },
  });
}
