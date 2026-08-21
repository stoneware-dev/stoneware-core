import type { PageProps } from "../../../src/routing/router.ts";

export default function Index({ locals }: PageProps) {
  return <p>hello {(locals as Record<string, unknown>).user as string}</p>;
}
