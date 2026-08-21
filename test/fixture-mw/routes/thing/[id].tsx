import type { PageProps } from "../../../../src/routing/router.ts";

/** A dynamic route, to prove middleware runs for those too. */
export default function Thing({ params, locals }: PageProps) {
  return (
    <p>
      thing {params.id} for {(locals as Record<string, unknown>).user as string}
    </p>
  );
}
