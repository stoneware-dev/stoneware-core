import type { PageProps } from "stoneware";

/** Deliberately no staticPaths export: nothing is written for this route. */
export default function Item({ params }: PageProps) {
  return <p>item {params.id}</p>;
}
