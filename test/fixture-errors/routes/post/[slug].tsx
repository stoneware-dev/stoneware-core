import { notFound } from "../../../../src/not-found.ts";
import type { PageProps } from "../../../../src/router.ts";

const POSTS: Record<string, string> = { hello: "Hello world" };

export default function Post({ params }: PageProps) {
  const title = POSTS[params.slug ?? ""];

  // A route with [params] matches any slug. Without this the template could
  // only render "no such post" markup, served with a 200.
  if (!title) notFound(`No post named ${params.slug}`);

  return <article>{title}</article>;
}
