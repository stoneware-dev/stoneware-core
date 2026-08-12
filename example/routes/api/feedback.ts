/**
 * A server action.
 *
 * By the time this runs, the framework has already verified the CSRF token —
 * there is no check to write here and no way to forget one.
 */

import type { ActionContext } from "stoneware";

interface Note {
  page: string;
  note: string;
  at: string;
}

/** In-memory for the demo; a real site would persist these. */
const notes: Note[] = [];

export async function POST({ request }: ActionContext): Promise<Response> {
  const form = await request.formData();
  const note = String(form.get("note") ?? "").trim();
  const page = String(form.get("page") ?? "unknown").slice(0, 64);

  const wantsJSON = request.headers.get("accept")?.includes("application/json");

  if (note.length === 0 || note.length > 500) {
    return respond(wantsJSON, 422, {
      ok: false,
      error: "Notes must be between 1 and 500 characters.",
    });
  }

  notes.push({ page, note, at: new Date().toISOString() });

  return respond(wantsJSON, 200, { ok: true });
}

/**
 * The island posts with `Accept: application/json`; a browser submitting the
 * form without JavaScript gets a redirect instead, so the no-JS path ends on a
 * real page rather than a wall of JSON.
 */
function respond(wantsJSON: boolean | undefined, status: number, body: Record<string, unknown>) {
  if (wantsJSON) return Response.json(body, { status });

  return new Response(null, {
    status: 303,
    headers: { Location: body.ok ? "/docs?noted=1" : "/docs?noted=0" },
  });
}
