import { seo } from "../../../src/seo.tsx";

export function head() {
  return seo({ title: "Correct" });
}

export default function Correct() {
  return <p>body</p>;
}
