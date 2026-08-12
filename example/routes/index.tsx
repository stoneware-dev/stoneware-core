import type { PageProps } from "stoneware";
import { Layout } from "../lib/Layout.tsx";
import { CodeBlock } from "../lib/highlight.tsx";
import { DOCS } from "../lib/docs.ts";
import InstallCommand from "../islands/InstallCommand.tsx";
import LiveCounter from "../islands/LiveCounter.tsx";

/**
 * Measured on this site's own production build (gzipped), not estimated.
 * Reproduce with: stoneware build --root example, then gzip .stoneware/static/*.js
 */
const STATS = [
  { label: "Client runtime", value: "3.2 KB" },
  { label: "One island", value: "0.2 KB" },
  { label: "Page with no islands", value: "0 B" },
  { label: "Runtime deps", value: "1" },
];

const PROBLEMS = [
  {
    problem: "You ship a runtime to render a document",
    answer:
      "A page with no islands ships zero bytes — no runtime, no hydration shim, no script tag. Asserted by the test suite, not just intended.",
  },
  {
    problem: "The client/server boundary drifts",
    answer:
      "The boundary is a directory, enforced by the build. Files under routes/ are never handed to the bundler, so they cannot reach the client.",
  },
  {
    problem: "You hydrate things that will never change",
    answer:
      "The header, footer and article have nothing to hydrate. They are strings the server produced, and they stay that way.",
  },
  {
    problem: "Security is opt-in, and CSP is what everyone skips",
    answer:
      "Stoneware never emits inline executable script, so script-src 'self' just works. This site runs under the default policy, unmodified.",
  },
];

const PRINCIPLES = [
  {
    title: "Server-first",
    body: "Every route renders to a complete HTML string. A page with no islands ships zero bytes of JavaScript — not a small runtime, not a hydration shim, nothing.",
  },
  {
    title: "No component model",
    body: "Templates are plain functions: props in, markup out. No classes, no hooks, no lifecycle. Logic lives in ordinary functions, not inside UI definitions.",
  },
  {
    title: "Signals, not an engine",
    body: "Islands use Preact Signals directly. Stoneware does not implement a reactive graph — that is a deliberate scope boundary, not an oversight.",
  },
  {
    title: "Interactivity by location",
    body: "A file under islands/ hydrates. A file under routes/ never does. No per-file directive to remember, and no way to make a page interactive by accident.",
  },
  {
    title: "Safe before configured",
    body: "Auto-escaping, automatic CSRF verification, and a restrictive CSP need no configuration to be on. The unsafe path requires typing more.",
  },
  {
    title: "Bun's own APIs",
    body: "Bun.serve, Bun.build, Bun.escapeHTML, Bun.CSRF, Bun.FileSystemRouter. No npm package reimplementing something the runtime already ships.",
  },
];

const ISLAND_EXAMPLE = `// islands/Counter.tsx — the only file here that ships JS
import { signal } from "stoneware/signals";

const count = signal(0);

export default function Counter() {
  return (
    <button onClick={() => count.value++}>
      Clicked {count} times
    </button>
  );
}`;

export default function Home(_props: PageProps) {
  return (
    <Layout
      title="Stoneware — shape your web application at build/server time"
      description="A server-first, Bun-native web framework. Complete HTML by default, islands for interactivity, signals inside islands, security on before you configure anything."
      section="home"
    >
      <section class="shell hero">
        <p class="eyebrow eyebrow--glaze rise">Bun-native · server-first · v0.1</p>
        <h1 class="hero__title rise">
          Shape your web application at <em>build/server time</em>
        </h1>
        <p class="hero__lede rise">
          A Bun-native, server-first framework where HTML is the default and JavaScript is opt-in.
          Build content-heavy sites without shipping a client runtime to pages that do not need one.
        </p>
        <dl class="stats rise">
          {STATS.map((stat) => (
            <div class="stat">
              <dt>{stat.label}</dt>
              <dd>{stat.value}</dd>
            </div>
          ))}
        </dl>
        <div class="hero__actions rise">
          <a class="btn btn--solid" href="/docs/quick-start">
            Quick start
          </a>
          <a class="btn" href="/docs">
            Read the docs
          </a>
        </div>
        <div class="scale rise">
          <span>Plain clay</span>
          <span>Bisque</span>
          <span>Glaze</span>
          <span>Vitrified</span>
        </div>
      </section>

      <section class="shell section reveal">
        <div class="section__head">
          <p class="eyebrow">The problem</p>
          <h2>The web ships JavaScript to sites that are documents</h2>
          <p>
            Stoneware inverts the default: HTML first, JavaScript only where you ask for it. Four specific
            problems that follow from it.
          </p>
        </div>
        <dl class="problems">
          {PROBLEMS.map((entry) => (
            <div class="problem">
              <dt>{entry.problem}</dt>
              <dd>{entry.answer}</dd>
            </div>
          ))}
        </dl>
        <p class="demo-note">
          <a href="/docs/why">All seven, and the ones it deliberately does not solve →</a>
        </p>
      </section>

      <section class="shell section reveal">
        <div class="section__head">
          <p class="eyebrow">Install</p>
          <h2>One command, either runner</h2>
          <p>
            Scaffolding runs on plain Node, so it works before Bun is installed. Everything after
            that runs on Bun.
          </p>
        </div>
        <InstallCommand />
      </section>

      <section class="shell section reveal">
        <div class="section__head">
          <p class="eyebrow">Principles</p>
          <h2>Six decisions, held consistently</h2>
          <p>
            Each of these is a constraint the framework enforces rather than a convention it
            suggests.
          </p>
        </div>
        <div class="principles">
          {PRINCIPLES.map((principle, index) => (
            <article class="principle">
              <span class="principle__index">{String(index + 1).padStart(2, "0")}</span>
              <h3>{principle.title}</h3>
              <p>{principle.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section class="shell section reveal">
        <div class="section__head">
          <p class="eyebrow">Islands</p>
          <h2>Interactivity you opt into</h2>
        </div>
        <div class="split">
          <div class="split__text">
            <CodeBlock code={ISLAND_EXAMPLE} label="islands/Counter.tsx" />
          </div>
          <div class="demo-frame">
            <p class="eyebrow">Live, on this page</p>
            <LiveCounter />
            <p class="demo-note">
              Server-rendered as static HTML, then hydrated. Clicking updates one text node — the
              tree is never re-run and nothing is diffed.
            </p>
          </div>
        </div>
      </section>

      <section class="shell section reveal">
        <div class="section__head">
          <p class="eyebrow">Documentation</p>
          <h2>Read on</h2>
        </div>
        <div class="card-grid">
          {DOCS.map((page) => (
            <a class="card" href={`/docs/${page.slug}`}>
              <h3>{page.title}</h3>
              <p>{page.summary}</p>
            </a>
          ))}
        </div>
      </section>
    </Layout>
  );
}
