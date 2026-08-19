import type { PageProps } from "stoneware";

/**
 * Personalized from a cookie, without ever touching CSRF — so nothing sets the
 * `personalized` flag, and this response used to be published as `public` with
 * no statement of what it depended on.
 */
export default function Account({ request }: PageProps) {
  const cookie = request.headers.get("cookie") ?? "";
  const user = /session=([^;]+)/.exec(cookie)?.[1] ?? "guest";
  return <main>Signed in as {user}</main>;
}
