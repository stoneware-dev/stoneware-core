import type { PageProps } from "stoneware";
import { Layout } from "../../lib/Layout.tsx";
import { DOCS } from "../../lib/docs.ts";

export default function DocsIndex(_props: PageProps) {
  return (
    <Layout
      title="Documentation — Stoneware"
      description="Guides for routing, islands, server actions, security defaults, and the CLI."
      section="docs"
    >
      <div class="shell">
        <section class="hero">
          <p class="eyebrow eyebrow--glaze">Documentation</p>
          {/* Counted rather than written out, so it cannot drift from DOCS. */}
          <h1>Everything, in {DOCS.length} pages</h1>
          <p class="hero__lede">
            Stoneware is small on purpose. If a page here feels long, that is a bug in the page rather
            than a sign of depth.
          </p>
        </section>

        <section class="section">
          <div class="card-grid">
            {DOCS.map((page) => (
              <a class="card" href={`/docs/${page.slug}`}>
                <h3>{page.title}</h3>
                <p>{page.summary}</p>
              </a>
            ))}
          </div>
        </section>
      </div>
    </Layout>
  );
}
