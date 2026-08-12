/**
 * Documentation content.
 *
 * Plain data, kept out of the templates entirely (CLAUDE.md §2.2). Pages read
 * from here and render it; nothing in this file knows what markup looks like.
 */

export type BlockKind = "p" | "h2" | "code" | "list" | "quote" | "figure";

export interface Block {
  kind: BlockKind;
  /** Prose for p/h2/quote, source for code, diagram text for figure. */
  text?: string;
  items?: string[];
  language?: "tsx" | "ts" | "sh" | "txt";
  /** Header for a code block; caption for a figure. */
  label?: string;
}

export interface DocPage {
  slug: string;
  title: string;
  summary: string;
  blocks: Block[];
}

export const DOCS: DocPage[] = [
  {
    slug: "why",
    title: "What it solves",
    summary: "The specific problems Sinter exists for — and the ones it does not.",
    blocks: [
      {
        kind: "p",
        text: "The web ships a lot of JavaScript to sites that do not need it. Sinter makes HTML the default and JavaScript the exception.",
      },
      {
        kind: "figure",
        label: "the whole decision",
        text: `           Mostly a document?
                   │
                   ▼
              Server HTML          ──►  0 KB client JS
                   │
           Need interaction here?
                   │
                   ▼
                Island            ──►  small, local client JS`,
      },
      {
        kind: "p",
        text: "Sinter is not a general-purpose replacement for anything. It was built for one shape of project: content-heavy, SEO-sensitive sites with a handful of interactive widgets. Within that shape, these are the problems it takes seriously.",
      },

      { kind: "h2", text: "1. You ship a runtime to render a document" },
      {
        kind: "p",
        text: "A blog post, a pricing page, a docs page: the content is fully known before the response finishes. Sending a framework runtime so the browser can reconstruct it is work nobody asked for, paid on every visit, on hardware you do not control.",
      },
      {
        kind: "p",
        text: "In Sinter a page with no islands ships no JavaScript. Not a small runtime, not a hydration shim — zero bytes, no script tag at all. That is asserted by the test suite, not just intended.",
      },
      {
        kind: "figure",
        label: "measured on this site's own production build, gzipped",
        text: `  Whole client runtime (signals + hydrate + DOM)     ~3.2 KB
  One island, e.g. the counter on the home page       ~0.2 KB
  A page with no islands                                   0 B

  Runtime dependencies                                       1
  (@preact/signals-core — everything else is Bun's own APIs)`,
      },

      { kind: "h2", text: "2. The client/server boundary drifts" },
      {
        kind: "p",
        text: "When the boundary is a directive that propagates through the import graph, it moves without being moved. One innocent import pulls a subtree to the client, and you discover it from a bundle analyzer weeks later.",
      },
      {
        kind: "p",
        text: "Sinter puts the boundary on the filesystem. Files under islands/ are bundler entry points; files under routes/ are never handed to the bundler at all. Server-only code does not stay server-only because a heuristic classified it correctly — it stays server-only because nothing can carry it across.",
      },
      {
        kind: "quote",
        text: "You cannot accidentally make a page interactive. There is no directive to forget, and no import that quietly changes where code runs.",
      },

      { kind: "h2", text: "3. Hydrating things that will never change" },
      {
        kind: "p",
        text: "Take a twenty-page company site where the only interactive parts are a newsletter form and a pricing calculator. A client-heavy architecture still asks the browser to boot a runtime and walk the whole page before any of it is live.",
      },
      {
        kind: "figure",
        label: "what actually needs to hydrate",
        text: `  Header        ──►  no
  Article       ──►  no
  SEO content   ──►  no
  Footer        ──►  no

  Newsletter    ──►  yes      islands/Newsletter.tsx
  Calculator    ──►  yes      islands/Calculator.tsx`,
      },
      {
        kind: "p",
        text: "The header is the same markup on every page and will never change after it is painted. Sinter does not hydrate it, because there is nothing there to hydrate — it is a string the server produced, and it stays that way.",
      },

      { kind: "h2", text: "4. The component model costs more than it returns here" },
      {
        kind: "p",
        text: "Hook ordering rules, dependency arrays, stale closures, and memoization as a standing performance tax are a reasonable trade for a complex application UI. For a page that renders once and then mostly sits there, it is overhead with no matching benefit.",
      },
      {
        kind: "p",
        text: "A Sinter template is a plain function, called once per request, on the server. Nothing to memoize, no render loop to reason about, no rules-of-hooks lint plugin. Reactivity exists only inside islands, where it earns its keep — and an update writes to one text node rather than re-running a tree.",
      },

      { kind: "h2", text: "5. Security is opt-in, and CSP is what everyone skips" },
      {
        kind: "p",
        text: "CSRF protection is usually middleware you have to remember on the right routes. Content-Security-Policy is usually absent, because adopting a strict one means fighting a framework that emits inline scripts and styles — so you end up with unsafe-inline, nonce plumbing, or nothing.",
      },
      {
        kind: "list",
        items: [
          "Escaping happens in the renderer. There is no global switch to turn it off.",
          "CSRF is verified in the request pipeline before any handler runs, on every mutating request. A raw <form> does not skip protection — it fails.",
          "A strict CSP ships by default and works, because Sinter never emits inline executable script. No nonces to plumb.",
          "A production build refuses to start without a CSRF secret rather than falling back to something that appears to work.",
        ],
      },
      {
        kind: "quote",
        text: "This documentation site runs under that default policy with no overrides. If any page here needed an exception, that would be a bug in the framework rather than in the page.",
      },

      { kind: "h2", text: "6. Hydration mismatches" },
      {
        kind: "p",
        text: "Reconciling a client tree against server markup produces a whole category of bug that only appears in production, usually as a warning nobody can reproduce. Sinter does not reconcile: it builds the island's tree and replaces the marked element outright. There is nothing to mismatch.",
      },
      {
        kind: "p",
        text: "The honest trade: this is a replacement, not a resumption. It happens as the island's bundle loads, before anyone has interacted with it, so in practice nothing is lost — but DOM state inside an island is not carried across the swap.",
      },

      { kind: "h2", text: "7. Toolchain sprawl" },
      {
        kind: "p",
        text: "A conventional setup accumulates a bundler, a dev server, a TS runner, dotenv, a CSRF library, a test runner, and the glue holding them together — each with its own config file and release cadence.",
      },
      {
        kind: "p",
        text: "Sinter has one runtime dependency. Serving, bundling, escaping, CSRF tokens, routing, .env loading, and the test runner are all Bun's own APIs. That is a deliberate constraint, not a coincidence: if Bun ships it, Sinter does not add a package that reimplements it.",
      },

      { kind: "h2", text: "What that looks like on a real site" },
      {
        kind: "p",
        text: "A company site: twenty pages, fifty blog posts, SEO metadata throughout, a contact form, a newsletter signup, and one pricing calculator. Almost all of it is a document. Three parts are not.",
      },
      {
        kind: "figure",
        label: "where each piece ends up",
        text: `  20 pages + 50 posts   ──►  routes/**            server-rendered HTML, 0 KB JS
  SEO metadata          ──►  routes/**            rendered, never hydrated

  contact form          ──►  routes/api/*.ts      server action, CSRF verified
  newsletter            ──►  islands/*.tsx        small island
  calculator            ──►  islands/*.tsx        small island

  everything else       ──►                       0 KB client JavaScript`,
      },
      {
        kind: "p",
        text: "The contact form does not even need an island: a <Form> posting to a server action works with JavaScript disabled, and the CSRF token is injected for you. An island is only worth it when you want the interaction to happen without a page load.",
      },

      { kind: "h2", text: "What it does not solve" },
      {
        kind: "p",
        text: "Worth stating plainly, because a framework that claims everything is useful for nothing. Sinter has nothing to say about databases, authentication, offline support, realtime collaboration, or large-scale client state. It is a rendering and routing layer with sensible security defaults, and that is the whole of it.",
      },
      {
        kind: "p",
        text: "It also does not make a site automatically fast or automatically secure. It removes a category of framework-level mistake — unescaped interpolation, a forgotten CSRF check, an absent CSP, JavaScript shipped for no reason. Your own queries, your own auth, and your own payload sizes remain yours.",
      },

      { kind: "h2", text: "When not to use it" },
      {
        kind: "p",
        text: "The fastest way to be disappointed by Sinter is to bring it to a problem it was not built for.",
      },
      {
        kind: "list",
        items: [
          "Genuinely app-like UI — a dashboard, an editor, anything with heavy shared client state. Use a SPA framework; that is what they are good at.",
          "You need client-side routing. Sinter does full page loads.",
          "You need streaming SSR, resumability, or partial rendering. Deliberately deferred for v0.1.",
          "You are not on Bun. Sinter is Bun-native by design, not Node-compatible-via-Bun.",
          "You need a large plugin ecosystem. This is v0.1; there isn't one.",
        ],
      },
      {
        kind: "p",
        text: "If your page is mostly a document with a few live parts, the trades above are nearly all upside. If it is mostly an application, almost none of them are.",
      },
    ],
  },

  {
    slug: "quick-start",
    title: "Quick start",
    summary: "Scaffold a project, run it, and understand what the two directories mean.",
    blocks: [
      {
        kind: "p",
        text: "Scaffolding runs on plain Node, so it works before Bun is installed. Everything after that — the dev server, the build — runs on Bun.",
      },
      {
        kind: "code",
        language: "sh",
        label: "terminal",
        text: `bunx create-sinter my-site   # npx create-sinter my-site also works
cd my-site
bun install
bun run dev`,
      },
      { kind: "h2", text: "What you get" },
      {
        kind: "list",
        items: [
          "routes/ — server-rendered pages and API routes. Never ships JavaScript.",
          "islands/ — interactive components. The only place client JS originates.",
          "lib/ — behavior functions and shared utilities.",
          "public/ — static assets, served as-is.",
          "sinter.config.ts — port, CSP, CSRF settings.",
        ],
      },
      {
        kind: "p",
        text: "That split is the whole mental model. A component is interactive because of the directory it lives in, not because of a directive written inside it.",
      },
      { kind: "h2", text: "Your first page" },
      {
        kind: "code",
        label: "routes/index.tsx",
        text: `import type { PageProps } from "sinter";

export default function Home({ params }: PageProps) {
  return <h1>It renders on the server</h1>;
}`,
      },
      {
        kind: "p",
        text: "A template is a plain function: props in, markup out. There is no base class to extend, no hook to call, and no lifecycle to learn. It runs once per request, on the server.",
      },
    ],
  },

  {
    slug: "project-structure",
    title: "What gets generated",
    summary: "Every file create-sinter writes, what it is for, and what a build adds.",
    blocks: [
      {
        kind: "p",
        text: "A new project is eleven files. There is no hidden state, no lockfile-adjacent cache to understand, and nothing generated that you are not meant to read.",
      },
      {
        kind: "figure",
        label: "bunx create-sinter my-site",
        text: `my-site/
│
├── routes/                    Server-only. Never ships JavaScript.
│   └── index.tsx              A page. Maps to "/"
│
├── islands/                   The only place client JS originates.
│   └── Counter.tsx            Hydrates on load. Gets its own bundle.
│
├── lib/                       Behavior functions and shared utilities.
│                              Ships JS only if an island imports it.
│
├── public/                    Served as-is, at the URL root.
│   └── styles.css             -> GET /styles.css
│
├── sinter.config.ts             Port, CSP override, CSRF settings.
├── tsconfig.json              jsx: "react-jsx", jsxImportSource: "sinter"
├── package.json               scripts: dev / build / start
│
├── .env                       SINTER_CSRF_SECRET, generated unique. Gitignored.
├── .env.example               Tracked template, no value.
└── .gitignore                 node_modules/ .sinter/ .env`,
      },
      { kind: "h2", text: "The two directories that matter" },
      {
        kind: "p",
        text: "routes/ and islands/ are not a style preference. They are the mechanism behind the framework's central claim, and the difference is enforced by the build rather than by convention.",
      },
      {
        kind: "figure",
        label: "why the split is structural",
        text: `routes/**          islands/**
    │                  │
    │                  └──► entry point for Bun.build (browser target)
    │                             │
    │                             └──► shipped to the client
    │
    └──► never passed to the bundler at all
              │
              └──► cannot reach the client, by construction`,
      },
      {
        kind: "p",
        text: "Nothing scans your route files for a directive and decides. Server-only code is not excluded by a heuristic that might get it wrong — it is simply never handed to the bundler.",
      },
      { kind: "h2", text: "What a build adds" },
      {
        kind: "p",
        text: "sinter build writes everything into .sinter/, which is gitignored. Deleting it is always safe.",
      },
      {
        kind: "figure",
        label: "sinter build",
        text: `my-site/.sinter/
│
├── server.js               One bundle: framework + every route + every island.
│                           Routes are inlined, so no transpiling per request.
│
├── islands.json            Island name -> public chunk URL.
│                           { "Counter": "/_sinter/Counter-jzp1gax8.js" }
│
├── static/                 Served under /_sinter/*, immutable (content-hashed).
│   ├── Counter-jzp1gax8.js     One entry chunk per island.
│   └── chunk-gcapcpwn.js       Shared runtime: signals + hydrate.
│
└── entries/                Generated island entry points. Build input.`,
      },
      {
        kind: "quote",
        text: "routes/ must still exist at runtime. Route modules are inlined into server.js, but path matching reads the directory for its filenames — never for its contents.",
      },
      {
        kind: "p",
        text: "The shared chunk is why a page with three islands does not download signals three times. Each island entry is small; the runtime they have in common is hoisted out once.",
      },
    ],
  },

  {
    slug: "how-it-works",
    title: "How it works",
    summary: "The path a request takes, and what hydration does to the DOM.",
    blocks: [
      {
        kind: "p",
        text: "Sinter is small enough to hold in your head. This page is the whole of it: one request pipeline, one render pass, and one hydration step.",
      },
      { kind: "h2", text: "The request pipeline" },
      {
        kind: "p",
        text: "Every response leaves through a single function, which is what makes the security headers structural rather than something each route remembers.",
      },
      {
        kind: "figure",
        label: "one request, start to finish",
        text: `  Request
     │
     ├─ /_sinter/*  ─────────────────►  built island chunk        (Bun.file)
     │
     ├─ matches public/  ──────────►  static asset              (Bun.file)
     │
     ├─ router.match(pathname)
     │      └─ no match  ──────────►  404
     │
     ├─ CSRF verify        ◄─────── every non-GET request, before any
     │      └─ invalid  ───────────►  403      handler can observe it
     │
     ├─ action route  ─────────────►  POST/PUT/DELETE handler ──┐
     │                                                          │
     └─ page route                                              │
            │                                                   │
            ├─ component(props)  ──►  VNode tree                 │
            ├─ renderToString    ──►  HTML string  (escaping)    │
            ├─ buildDocument     ──►  + payload + scripts        │
            │                                                   │
            └───────────────┬───────────────────────────────────┘
                            ▼
                  security headers applied   ◄── single exit point
                            │
                            ▼
                        Response`,
      },
      { kind: "h2", text: "The render pass" },
      {
        kind: "p",
        text: "A template is called once. It returns an inert { type, props } record, which the renderer walks depth-first, appending to a string. There is no previous tree, no diff, and nothing retained afterwards.",
      },
      {
        kind: "figure",
        label: "render-once-to-string",
        text: `  <Page />
     │
     │  Bun transpiles TSX ──► jsx("div", { children: [...] })
     ▼
  VNode  { type, props }        inert data, no methods, no instance
     │
     │  renderToString walks it once
     ▼
  ┌──────────────────────────────────────────────┐
  │  string        ──► escaped via Bun.escapeHTML │
  │  number        ──► escaped                    │
  │  signal        ──► .value, then escaped       │
  │  raw("...")    ──► emitted verbatim  ◄── the only way through
  │  function type ──► called, result walked      │
  │  island        ──► marked + props collected   │
  └──────────────────────────────────────────────┘
     │
     ▼
  HTML string`,
      },
      { kind: "h2", text: "What the server sends" },
      {
        kind: "p",
        text: "An island is server-rendered with its real initial state, so there is no flash of empty content. Three things go into the response: the markup, a props payload, and one module script per distinct island.",
      },
      {
        kind: "code",
        language: "txt",
        label: "response body, abridged",
        text: `<button class="counter"
        data-sinter-island="LiveCounter"    <-- which island
        data-sinter-id="sinter-1">            <-- which instance
  fired <b>0</b> times
</button>

<script type="application/json" id="sinter-islands">
  [{"name":"LiveCounter","id":"sinter-1","props":{}}]
</script>

<script type="module" src="/_sinter/LiveCounter-6dhtkfqt.js"></script>`,
      },
      {
        kind: "p",
        text: "The markers sit on the island's own root element rather than a wrapper, so the served HTML has no extra node and no layout impact. That is why an island must render exactly one element at its root.",
      },
      {
        kind: "quote",
        text: 'The payload is type="application/json", which browsers never execute, and its <, >, & and U+2028/9 are escaped. Nothing user-controlled is ever concatenated into executable script source.',
      },
      { kind: "h2", text: "What hydration does to the DOM" },
      {
        kind: "figure",
        label: "server output, then the same DOM after hydration",
        text: `  BEFORE                              AFTER
  ──────                              ─────
  <button data-sinter-id="sinter-1">      <button data-sinter-id="sinter-1">
    "fired "                            "fired "        ◄─ static text
    <b>                                 <b>
      "0"                                 "0"  ◄────────── Text node, now
    </b>                                </b>              bound by effect()
    " times"                            " times"
  </button>                           </button>
                                        ▲
  inert markup                          └─ click listener attached

  count.value++
      │
      └─► effect fires ─► node.data = "1"     one text node written
                                              no re-render, no diff`,
      },
      {
        kind: "p",
        text: "The client runtime builds the tree once, replaces the marked element, and attaches a subscription to the exact text node or attribute that depends on each signal. Updating a signal does not call the component again.",
      },
      {
        kind: "figure",
        label: "the client runtime, end to end",
        text: `  island bundle loads
     │
     ├─ read #sinter-islands  ──► parsed as data, never evaluated
     │
     ├─ for each { name, id, props } matching this island:
     │      │
     │      ├─ component(props)  ──► VNode tree
     │      ├─ mountTree(vnode)  ──► real DOM nodes
     │      │      │
     │      │      ├─ signal child      ──► Text node + effect()
     │      │      ├─ signal attribute  ──► effect() -> setAttribute
     │      │      ├─ style object      ──► CSSOM (CSP-safe)
     │      │      └─ onClick           ──► addEventListener
     │      │
     │      └─ querySelector([data-sinter-id]).replaceWith(tree)
     │
     └─ done. No further work until a signal changes.`,
      },
      { kind: "h2", text: "Why there is no reconciler" },
      {
        kind: "p",
        text: "A virtual DOM earns its cost when you re-render a whole tree and need to find what changed. Sinter never re-renders a tree, so there is nothing to compare. The dependency graph that would justify a reconciler is already provided by signals, which is why reusing them rather than writing one is the project's firmest scope boundary.",
      },
    ],
  },

  {
    slug: "routing",
    title: "Routing",
    summary: "File-based, Next.js-style conventions resolved by Bun's own router.",
    blocks: [
      {
        kind: "p",
        text: "Routes map from the filesystem using the conventions most developers already know. Path resolution is delegated to Bun.FileSystemRouter rather than reimplemented.",
      },
      {
        kind: "code",
        language: "txt",
        label: "routes/",
        text: `routes/index.tsx          ->  /
routes/about.tsx          ->  /about
routes/blog/[slug].tsx    ->  /blog/:slug
routes/api/subscribe.ts   ->  /api/subscribe`,
      },
      { kind: "h2", text: "Pages and actions" },
      {
        kind: "p",
        text: "A module that default-exports a component is a page. A module that exports HTTP method handlers is a server action. Nothing else distinguishes them — there is no config file listing routes.",
      },
      {
        kind: "code",
        label: "routes/blog/[slug].tsx",
        text: `import type { PageProps } from "sinter";
import { getPost } from "../../lib/posts.ts";

export default function Post({ params }: PageProps) {
  const post = getPost(params.slug);
  if (!post) return <h1>Not found</h1>;

  return (
    <article>
      <h1>{post.title}</h1>
      <time datetime={post.date}>{post.date}</time>
    </article>
  );
}`,
      },
      {
        kind: "p",
        text: "Params arrive percent-decoded and are escaped like any other value when interpolated, so a slug containing markup is inert.",
      },
    ],
  },

  {
    slug: "islands",
    title: "Islands",
    summary: "How a component earns its JavaScript, and what hydration actually does.",
    blocks: [
      {
        kind: "p",
        text: "An island is a subtree that owns its own interactivity. Everything outside it stays inert HTML forever, which means it costs nothing to send and nothing to run.",
      },
      {
        kind: "code",
        label: "islands/Counter.tsx",
        text: `import { signal } from "sinter/signals";

const count = signal(0);

export default function Counter() {
  return (
    <button onClick={() => count.value++}>
      Clicked {count} times
    </button>
  );
}`,
      },
      { kind: "h2", text: "What happens on the server" },
      {
        kind: "list",
        items: [
          "The island renders to HTML with its initial state, so there is no flash of empty content.",
          "Its root element is tagged with a hydration marker.",
          "Its props are serialized into a non-executable JSON block.",
          "One module script per distinct island is added before </body>.",
        ],
      },
      {
        kind: "quote",
        text: "An island must render exactly one HTML element at its root, because that element carries the marker. Sinter raises an explicit error rather than mis-hydrating.",
      },
      { kind: "h2", text: "Updates without a reconciler" },
      {
        kind: "p",
        text: "Changing a signal does not re-run the component. The subscription is attached to the exact text node or attribute that depends on it, so the update writes one value. There is no virtual DOM and nothing to diff.",
      },
      { kind: "h2", text: "Sharing state between islands" },
      {
        kind: "p",
        text: "Export a signal from a module and import it in more than one island. They compile to separate bundles, but the bundler hoists the shared module into a common chunk, so both observe the same instance.",
      },
      {
        kind: "code",
        label: "lib/state.ts",
        text: `import { signal } from "sinter/signals";

export const subscriberCount = signal(1284);`,
      },
    ],
  },

  {
    slug: "server-actions",
    title: "Server actions",
    summary: "Form handling where CSRF verification is structural, not a decorator.",
    blocks: [
      {
        kind: "p",
        text: "Any exported HTTP method handler under routes/api/ is a server action. By the time it runs, the framework has already verified the CSRF token.",
      },
      {
        kind: "code",
        label: "routes/api/subscribe.ts",
        text: `import type { ActionContext } from "sinter";

export async function POST({ request }: ActionContext) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");

  return Response.json({ ok: true });
}`,
      },
      { kind: "h2", text: "Forms" },
      {
        kind: "p",
        text: "Use the Form helper instead of a raw form element and the hidden token field is injected for you.",
      },
      {
        kind: "code",
        label: "routes/index.tsx",
        text: `import { Form } from "sinter";

<Form action="/api/subscribe">
  <input type="email" name="email" required />
  <button type="submit">Subscribe</button>
</Form>;`,
      },
      {
        kind: "p",
        text: "Verification happens in the request pipeline, before any handler is reached, on every non-GET request. It is not something a route opts into — a raw form does not silently skip protection, it simply fails. The token is checked against a clone of the request, so your handler still receives an unconsumed body.",
      },
      {
        kind: "p",
        text: "For an island doing its own fetch(), pass the token in as a prop with csrfToken() and send it in the x-csrf-token header.",
      },
    ],
  },

  {
    slug: "security",
    title: "Security defaults",
    summary: "What is on before you configure anything, and why it cannot be off by accident.",
    blocks: [
      {
        kind: "p",
        text: "Every security-relevant default is safe with an empty config object. Weakening one requires naming it explicitly; there is no path to an insecure setup by omission.",
      },
      { kind: "h2", text: "Escaping" },
      {
        kind: "p",
        text: "Every interpolated value passes through Bun.escapeHTML() on the way out. Not by convention and not by lint rule — by the renderer, with no global switch to turn it off.",
      },
      {
        kind: "code",
        text: `<p>{userInput}</p>           // always escaped
<p>{raw("<em>ok</em>")}</p>  // the only way through`,
      },
      {
        kind: "p",
        text: "raw() is deliberately more effort than the safe path, and greppable during review. Two things the renderer refuses outright, because escaping cannot make them safe: interpolating dynamic values into script or style bodies, and attribute names that could break out of a tag.",
      },
      { kind: "h2", text: "Content-Security-Policy" },
      {
        kind: "p",
        text: "A restrictive policy ships by default: script-src 'self', no unsafe-inline, no unsafe-eval. Sinter never emits inline executable script, so no nonce plumbing is needed to satisfy it.",
      },
      {
        kind: "quote",
        text: "This documentation site runs under that default policy, unmodified. The dev server serves its live-reload client as a real file rather than an inline script, so development and production run the same policy.",
      },
      {
        kind: "p",
        text: "One consequence worth knowing: style-src 'self' blocks inline style attributes too. Islands that need to drive a value at runtime write a CSS custom property through the CSSOM, which CSP does not govern. The scroll gauge on this page works that way.",
      },
      { kind: "h2", text: "Everything else" },
      {
        kind: "list",
        items: [
          "Hydration payloads are JSON in a non-executable block, with <, >, & and U+2028/9 escaped.",
          "X-Content-Type-Options, X-Frame-Options and Referrer-Policy on every response.",
          "Static file serving refuses path traversal.",
          "A production build refuses to start without a CSRF secret.",
        ],
      },
      {
        kind: "p",
        text: "Every response leaves through a single function that applies these headers, so a new route cannot forget them.",
      },
    ],
  },

  {
    slug: "cli",
    title: "CLI and builds",
    summary: "Dev server, production build, and what each command actually emits.",
    blocks: [
      {
        kind: "code",
        language: "sh",
        label: "terminal",
        text: `sinter dev     # dev server with hot reload
sinter build   # production build
sinter start   # run the production server bundle`,
      },
      { kind: "h2", text: "Development" },
      {
        kind: "p",
        text: "One process serves pages, built island chunks, and the live-reload socket. There is no second dev server and no proxy. Editing a file under routes/, islands/ or lib/ rebuilds and reloads the browser.",
      },
      { kind: "h2", text: "Production" },
      {
        kind: "list",
        items: [
          "One server bundle, with every route and island statically imported so no transpilation happens per request.",
          "One content-hashed client chunk per island, plus a shared runtime chunk.",
          "An island manifest, so the server serves pre-built chunks instead of rebuilding at boot.",
        ],
      },
      {
        kind: "quote",
        text: "Route modules are inlined into the server bundle, but path matching still uses Bun.FileSystemRouter, so routes/ must exist at runtime. It is read for its filenames, never its contents.",
      },
      { kind: "h2", text: "Environment" },
      {
        kind: "p",
        text: "Bun reads .env natively, so Sinter has no dotenv dependency. create-sinter generates a .env with a unique SINTER_CSRF_SECRET and gitignores it, leaving .env.example as the tracked template. A real environment variable beats .env.local, which beats .env.",
      },
    ],
  },
];

export function getDoc(slug: string): DocPage | undefined {
  return DOCS.find((page) => page.slug === slug);
}

export interface DocNeighbors {
  previous?: DocPage;
  next?: DocPage;
}

export function getNeighbors(slug: string): DocNeighbors {
  const index = DOCS.findIndex((page) => page.slug === slug);
  if (index === -1) return {};
  return { previous: DOCS[index - 1], next: DOCS[index + 1] };
}
