import { seo } from "../../../src/helpers/seo.tsx";

/** seo() in the body of a page that uses the framework's shell: the mistake. */
export default function Stranded() {
  return (
    <main>
      {seo({ title: "Stranded" })}
      <p>body</p>
    </main>
  );
}
