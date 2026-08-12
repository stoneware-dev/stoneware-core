import type { ActionContext } from "kiln";

/** POST only, so GET must produce a 405 with an Allow header. */
export async function POST({ request }: ActionContext): Promise<Response> {
  const form = await request.formData();
  return Response.json({ ok: true, message: String(form.get("message") ?? "") });
}
