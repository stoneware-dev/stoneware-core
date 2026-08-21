import { seo } from "../../../src/helpers/seo.tsx";

export function head() {
  return seo({ title: "Correct" });
}

export default function Correct() {
  return <p>body</p>;
}
