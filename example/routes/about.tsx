import { raw } from "kiln";
import type { PageProps } from "kiln";
import { Layout } from "../lib/Layout.tsx";

/** Author-controlled markup, audited once, opted into explicitly. */
const PITCH = raw(
  "Fresh, but <em>Bun-native</em> instead of Deno-native, with a non-component template model.",
);

export default function About(_props: PageProps) {
  return (
    <Layout title="About kiln">
      <article class="post">
        <h1>About</h1>
        <p>{PITCH}</p>
        <p>
          Kiln renders every route to complete HTML on the server. Interactivity is opt-in per
          directory: a component ships JavaScript only if it lives in <code>islands/</code>.
        </p>
        <h2>Escaping</h2>
        <p>
          The paragraph above renders italics because it was wrapped in <code>raw()</code>. Ordinary
          interpolation never does — this, for instance, is a string containing markup and it stays a
          string: {"<script>alert(1)</script>"}
        </p>
      </article>
    </Layout>
  );
}
