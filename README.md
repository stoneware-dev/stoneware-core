# stoneware

**A Bun-native, server-first web framework where HTML is the default and JavaScript is opt-in.**
Build content-heavy sites without shipping a client runtime to pages that do not need one.

The web sends a lot of JavaScript to sites that are mostly documents. Stoneware inverts the default: every
route renders to complete HTML, and a component ships JavaScript only if you put it in `islands/`.
Escaping, CSRF verification, and a strict CSP are on before you write any configuration.

Measured on this repo's own documentation site, in production:

| | |
|---|---|
| Whole client runtime (signals + hydrate + DOM) | ~3.2 KB gzipped |
| One island (the counter on the home page) | ~0.2 KB gzipped |
| A page with no islands | **0 bytes, no script tag** |
| Runtime dependencies | **1** (`@preact/signals-core`) |

```sh
bunx create-stoneware my-site   # npx create-stoneware my-site works too
cd my-site
bun install
bun run dev
```

Scaffolding runs on plain Node, so `npx` works before Bun is installed. Everything after that — the
dev server, the build — runs on Bun, and `stoneware` says so with an install link if Bun is missing.

## What problems it solves

**1. You ship a runtime to render a document.** A blog post is fully known before the response
finishes; sending a framework so the browser can rebuild it is work nobody asked for. A Stoneware page
with no islands ships zero bytes — asserted by the test suite, not just intended.

**2. The client/server boundary drifts.** When the boundary is a directive that propagates through
the import graph, one innocent import pulls a subtree client-side and you find out from a bundle
analyzer. Here the boundary is a directory, and it is enforced by the build: `routes/` files are
never handed to the bundler, so they *cannot* reach the client.

**3. You hydrate things that will never change.** On a twenty-page site where only the newsletter and
a calculator are interactive, the header, footer, article and SEO markup have nothing to hydrate.
Stoneware doesn't — they are strings the server produced, and they stay that way.

**4. The component model costs more than it returns here.** Hook ordering, dependency arrays, stale
closures, and memoization-as-tax are a fair trade for an application UI. For a page that renders once
and then sits there, it is overhead with no matching benefit. A template is a plain function called
once, on the server.

**5. Security is opt-in, and CSP is what everyone skips.** A strict CSP is normally painful because
frameworks emit inline script and style, so you end up with `unsafe-inline`, nonce plumbing, or
nothing. Stoneware never emits inline executable script, so `script-src 'self'` simply works — this repo's
docs site runs under the default policy unmodified, with zero violations.

**6. Hydration mismatches.** Stoneware does not reconcile against server markup; it builds the island's
tree and replaces the marked element. There is nothing to mismatch. (The honest trade: a replacement,
not a resumption.)

**7. Toolchain sprawl.** Serving, bundling, escaping, CSRF tokens, routing, `.env`, and the test
runner are all Bun's own APIs. If Bun ships it, Stoneware does not add a package that reimplements it.

### What it does not solve

Stoneware has nothing to say about databases, authentication, offline support, realtime collaboration, or
large-scale client state. It does not make a site automatically fast or automatically secure — it
removes a category of *framework-level* mistake. Your queries, your auth, and your payload sizes
remain yours.

### When not to use it

- Genuinely app-like UI — a dashboard, an editor, heavy shared client state. Use a SPA framework.
- You need client-side routing. Stoneware does full page loads.
- You need streaming SSR, resumability, or partial rendering. Deferred for v0.1.
- You are not on Bun. Stoneware is Bun-native by design, not Node-compatible-via-Bun.
- You need a plugin ecosystem. This is v0.1; there isn't one.

If your page is mostly a document with a few live parts, these trades are nearly all upside. If it is
mostly an application, almost none of them are.

## The five decisions that define it

**1. Server-first.** Every route renders to a complete HTML string on the server. A page with no
islands ships zero bytes of JavaScript - not a small runtime, not a hydration shim, nothing.

**2. No component model.** Templates are plain functions: props in, markup out. No classes, no hooks,
no `useState`, no lifecycle. Logic lives in ordinary functions in `lib/`, not inside UI definitions.

```tsx
// routes/index.tsx - called once per request, on the server
export default function Home({ params }: PageProps) {
  return <h1>Hello</h1>;
}
```

**3. Signals, not a bespoke reactivity engine.** Islands use
[Preact Signals](https://github.com/preactjs/signals) directly, re-exported as `stoneware/signals`. Stoneware
does not implement a reactive graph. That is a deliberate scope boundary, not an oversight.

**4. Islands are opt-in by location.** A file under `islands/` hydrates. A file under `routes/` never
does. There is no per-file directive to remember and no way to make a page interactive by accident.

**5. Security is on by default.** Auto-escaping, automatic CSRF verification, and a restrictive CSP
require no configuration to get the safe behavior. The unsafe path requires typing more.

## Project layout

```
my-site/
  routes/                  file-based routing, server-only
    index.tsx              -> /
    blog/[slug].tsx        -> /blog/:slug
    api/subscribe.ts       -> server action (POST/PUT/DELETE handlers)
    _404.tsx               -> shown for any unmatched path (optional)
    _500.tsx               -> shown when a page throws (optional)
  islands/                 the only place client JS originates
    Counter.tsx
  lib/                     behavior functions, shared utilities
  public/                  static assets, served as-is
  stoneware.config.ts
```

Routing mirrors the Next.js conventions you already know, resolved by `Bun.FileSystemRouter`.

## Templates

Templates are `.tsx` files exporting a default function. Interpolated values are escaped by
`Bun.escapeHTML()` automatically:

```tsx
<p>{userInput}</p>          // always escaped
<p>{raw("<em>ok</em>")}</p> // the only way through, and deliberately awkward
```

`raw()` is greppable on purpose. If it appears in a diff, it should be read carefully.

Two things the renderer refuses outright, because escaping cannot make them safe:

- Interpolating dynamic values into `<script>` or `<style>` bodies.
- Attribute names that could break out of a tag (relevant when spreading untrusted objects).

## Styling

Put a `.css` file next to the code it styles:

```
routes/index.tsx      lib/Card.tsx        islands/Counter.tsx
routes/index.css      lib/Card.css        islands/Counter.css
```

The build collects every stylesheet under `routes/`, `islands/` and `lib/`,
bundles them into one content-hashed file, and injects the `<link>` into `<head>`
automatically. There is no import to write and no `<link>` to maintain.

Membership is by **location, not by `import`**. Routes and `lib/` are server
modules the bundler never sees — an `import "./Card.css"` there resolves to a
path string at runtime and would never be collected. Scanning gives one rule for
all three directories instead of a different one per directory. Files are sorted
before bundling, so the cascade is deterministic and the content hash only
changes when the CSS does.

> **No CSS Modules.** Bun's *runtime* returns the file path rather than the class
> map, so a server render and a client bundle would disagree on class names —
> and islands are rendered by both. Scoping is naming discipline for now.

## Islands and signals

```tsx
// islands/Counter.tsx
import { signal } from "stoneware/signals";

const count = signal(0);

export default function Counter() {
  return <button onClick={() => count.value++}>Clicked {count} times</button>;
}
```

An island is server-rendered into the initial HTML (no flash of empty content), bundled into its own
client chunk, and hydrated on load. Updates do not re-render the tree - a signal subscription is
attached to the exact text node or attribute that depends on it. There is no VDOM and no diffing.

**One constraint:** an island must render exactly one HTML element at its root, because that element
carries the hydration marker. You get a clear error if it does not.

**Shared state between islands** is just a shared module:

```ts
// lib/state.ts
export const subscriberCount = signal(1284);
```

Import it from two different islands and both observe the same signal. The bundler hoists it into a
shared chunk automatically.

## When islands hydrate

By default an island hydrates as soon as its chunk loads. A `client:*` directive at the **usage
site** defers that — the same island can be eager on one page and lazy on another:

```tsx
<Chart />                                {/* default: on load        */}
<Chart client:visible />                 {/* when scrolled into view */}
<Chart client:idle />                    {/* when the browser is idle */}
<Chart client:media="(min-width: 60rem)" /> {/* when the query matches */}
```

**A lazy island emits no `<script>` tag.** Its chunk URL travels inside the JSON payload instead, and
a page with any deferred island loads a small scheduler that fetches the chunk when the trigger
fires. Concretely, for a page whose islands are all `client:visible`:

| | eager | `client:visible` |
|---|---|---|
| On load | scheduler + runtime + every island chunk | **scheduler only, ~1 kB gzip** |
| On scroll | — | runtime + that island's chunk |

The fetch is a same-origin dynamic `import()`, so it runs under the default `script-src 'self'` with
no nonce and no inline script.

Details worth knowing:

- `client:visible` starts hydrating **200 px before** the element reaches the viewport, so it is
  usually ready by the time it is on screen.
- Every trigger **degrades to hydrating immediately** if the API behind it is missing. A browser with
  no `IntersectionObserver` gets a working page slightly sooner than intended, never a dead button.
- The directive is stripped before the island runs — an island never sees `client:visible` in its
  props and needs no awareness of any of this.
- Two directives on one usage is an error rather than a precedence rule to memorize.
- A directive on a plain element is an error too: only islands hydrate, and silently rendering it as
  an attribute would look correct while never working.

**A page with no lazy island is byte-for-byte what it was before.** The scheduler is not loaded, and
the payload carries no strategy field.

## Server actions and CSRF

Any exported HTTP method handler in `routes/api/` is a server action:

```ts
// routes/api/subscribe.ts
export async function POST({ request }: ActionContext) {
  const form = await request.formData();
  return Response.json({ ok: true });
}
```

Use the `<Form>` helper rather than a raw `<form>` and the CSRF token is injected for you:

```tsx
<Form action="/api/subscribe">
  <input type="email" name="email" required />
  <button type="submit">Subscribe</button>
</Form>
```

Verification happens in the request pipeline, before any handler runs, on every non-GET request.
It is not a per-route opt-in - a raw `<form>` does not silently skip protection, it simply fails.
The body is verified against a clone, so your handler still receives an unconsumed request.

For an island doing its own `fetch()`, pass the token in as a prop with `csrfToken()` and send it in
the `x-csrf-token` header.

Set `STONEWARE_CSRF_SECRET` in production. Without it, a production build refuses to start rather than
falling back to something that appears to work.

## Error pages

Add `routes/_404.tsx` or `routes/_500.tsx` and they replace the built-in pages. They are ordinary
templates - your layout, your islands, your CSS:

```tsx
// routes/_404.tsx
import type { ErrorPageProps } from "stoneware";

export default function NotFound({ url }: ErrorPageProps) {
  return <Layout title="Not found">No page at {url.pathname}</Layout>;
}
```

`_500.tsx` additionally receives `error`, **populated in development only**. In production it is
`undefined` rather than left to each error page to handle responsibly - an exception message
routinely carries a file path, a query, or a connection string.

A file whose name starts with `_` is a convention, not a page. `/_404` is not routable; requesting it
returns the 404 page, with a 404 status.

Three properties hold whether or not you define these pages:

- **Failure is terminal.** If your `_500.tsx` throws, the built-in page is served. The error path
  never re-enters itself.
- **Errors are never cached** - `Cache-Control: no-store`. A 404 held by a CDN outlives the deploy
  that adds the missing page, and a 500 captured during an incident outlives the fix.
- **Security headers still apply.** Error responses leave through the same exit as every other
  response.

`stoneware export` writes the 404 page to `dist/404.html`, which is the file Cloudflare Pages,
Netlify and GitHub Pages each serve for an unmatched path.

## Environment variables

Bun reads `.env`, `.env.local`, and `.env.<mode>` natively, so Stoneware has no dotenv dependency -
consistent with the rule that the framework uses Bun's own APIs rather than npm packages that
reimplement them.

`create-stoneware` generates a `.env` containing a freshly random `STONEWARE_CSRF_SECRET`, gitignores it, and
leaves `.env.example` as the tracked template:

```
STONEWARE_CSRF_SECRET=<unique per environment>
```

Precedence is `.env.local` over `.env`, and a real environment variable over both - so a deploy
target's own configuration always wins. `PORT` is honored the same way and overrides `port` in
`stoneware.config.ts`, which is what `stoneware dev --port` sets.

Keep the secret in the environment rather than in `stoneware.config.ts`, so it is never committed.
Rotating it invalidates every form currently rendered.

## Security defaults

| Default | Behavior |
|---|---|
| Escaping | `Bun.escapeHTML()` on all interpolation. `raw()` is the only escape hatch. |
| CSRF | Verified on every mutating request, before the handler. |
| CSP | `script-src 'self'`, no `unsafe-inline`, no `unsafe-eval`. Overridable, never silently absent. |
| Hydration payload | JSON in a non-executable `type="application/json"` block, with `<`, `>`, `&`, U+2028/9 escaped. Never concatenated into script source. |
| Headers | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` on every response. |

Every response leaves through one function that applies these headers, so a new route cannot forget
them. The dev server serves its live-reload client as a real file rather than an inline script,
specifically so development runs under the same CSP as production.

## Caching

Set automatically, and the distinction matters:

| Response | Header |
|---|---|
| Hashed island chunks and stylesheet | `immutable, max-age=31536000` — the name contains the content hash |
| `public/` assets | `no-cache` + `ETag` — revalidated, so a deploy is picked up immediately |
| HTML with no CSRF token | `public, no-cache` + `ETag` — a repeat request costs one 304 |
| HTML carrying a CSRF token | `private, no-store` — never shared, or one visitor gets another's token |
| Any error response | `no-store` — a cached 404 outlives the deploy that fixes it |

`no-cache` means *revalidate before use*, not *do not store*.

## CLI

```
stoneware dev     Start the dev server with hot reload
stoneware build   Production build (server bundle + island chunks)
stoneware start   Run the production server bundle
stoneware export  Prerender every page to static HTML
```

`stoneware build` emits one server bundle with every route and island statically imported, plus one
content-hashed chunk per island and a shared runtime chunk.

> **Note:** route modules are inlined into the server bundle, but path *matching* still uses
> `Bun.FileSystemRouter`, so `routes/` must exist at runtime. It is read for its filenames, never for
> its contents.

## Deploying

A Stoneware app is a Bun HTTP server. There is no adapter layer and no per-platform build target —
you add one file and run it.

```ts
// server.ts
import { createApp } from "stoneware";
import config from "./stoneware.config.ts";

const app = await createApp(config, { dev: false });

Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  fetch: (request) => app.fetch(request),
});
```

```sh
bun install
stoneware build      # writes .stoneware/
bun server.ts
```

**What the host must provide:** the Bun runtime, plus three things on disk at request time —
`routes/` (its filenames are read on every request), `.stoneware/islands.json` (the build manifest),
and `public/` if you serve assets. A directory that is only ever *scanned* is invisible to a bundler
tracing imports, which is what makes the next table matter.

| Host | Runs Bun | Ships whole directory | |
|---|---|---|---|
| VPS / Docker / Fly / Railway / Render | yes | yes | works as-is |
| Vercel | yes | **no — bundles** | needs `includeFiles` |
| Netlify Functions | no | — | wrong runtime |
| Cloudflare Workers | no | — | wrong runtime |

Cloudflare runs V8 isolates and Netlify Functions run Node, so neither can host a Stoneware *server* —
but `stoneware export` covers them.

### Static export

```sh
stoneware export --out dist
```

Every page is fetched through the ordinary request pipeline, so the HTML on disk is byte-identical to
what the server would have sent. Output is `dist/<path>/index.html` plus the island chunks and
`public/`, deployable to Cloudflare Pages, Netlify, GitHub Pages, or any CDN.

A route with `[params]` is only prerendered if its module says which pages exist:

```ts
export function staticPaths() {
  return listPosts().map((post) => ({ slug: post.slug }));
}
```

Two kinds of page are skipped and reported rather than written: server actions, and **any page that
renders a CSRF token**. A prerendered token would be frozen into the file and served to every
visitor, which is no protection at all — so it is never written to disk.

### Vercel

Vercel's Bun **framework preset** detects a single `Bun.serve()` in a root `server.ts` and routes all
requests through it. It needs `bun.lock` present and four lines of config:

```json
{
  "framework": "bun",
  "bunVersion": "1.x",
  "buildCommand": "bun node_modules/stoneware/bin/stoneware.mjs build"
}
```

> **`"framework": "bun"` is the line that matters.** If the preset is left as *Other*, Vercel treats
> the project as a static build: `server.ts` is never detected, no function is created, and every
> path returns `404: NOT_FOUND` — even though the build log reports success. Setting it in
> `vercel.json` overrides Project Settings, so it is version-controlled rather than a dashboard
> click someone has to remember.

Set `STONEWARE_CSRF_SECRET` as a project environment variable. If the app is a subdirectory of a
larger repo, set Root Directory to it — Vercel still clones the whole repository and only changes
directory into it.

> **Do not add a `functions` block for this.** `functions` patterns only match Serverless Functions
> inside an `api/` directory; with the framework preset there is no `api/`, and the build fails with
> *"The pattern `server.ts` … doesn't match any Serverless Functions inside the `api` directory."*
> There is no `includeFiles` equivalent for the preset.

If the function starts but crashes, the likely cause is that `routes/` or `.stoneware/islands.json`
did not reach the runtime. A serverless filesystem is read-only outside `/tmp`, so a missing build
manifest makes the server fall back to rebuilding island bundles, and that write fails in a way that
looks unrelated to the cause. Read the **function log**, not the page — it names the missing path.

The fallback, if the preset ever proves not to carry those directories, is the `/api` model: move the
entry to `api/server.ts` and add rewrites. `functions.includeFiles` *does* apply there, because the
pattern then matches a real function under `api/`.

## Documentation site

The documentation site is built with Stoneware and lives in its own repository:
[RANJEETJ06/stoneware-docs](https://github.com/RANJEETJ06/stoneware-docs).

It is the honest version of a feature list. The site runs under this framework's default CSP with no
overrides, so if a page there needed an exception that would be a bug here rather than in the page.
Four islands carry all of its interactivity — an install-command switcher, a live counter, a
scroll-linked gauge, and a feedback form backed by a server action — and every other page ships no
JavaScript at all. Code samples are syntax-highlighted on the server, so even that costs nothing.

It is kept separate on purpose: it consumes `stoneware` from npm exactly as any other project does,
so it cannot quietly depend on unreleased behaviour, and its deployment needs never leak into the
framework's own tooling.

## Testing

```sh
bun test
```

- **Unit** — renderer and escaping, router matching, CSRF verification.
- **Client runtime** — hydration and signal bindings, against a real DOM via happy-dom.
- **Integration** — one group per milestone, run against `test/fixture/`, a deliberately minimal app.
- **Budgets** — the client runtime's gzipped size, so the byte counts published above cannot
  silently become false.

Everything runs against `test/fixture/` rather than a real site: assertions on exact markup should
answer to framework behaviour only, never to editorial changes in someone's content.

## Status

v0.1. Deliberately **not** included yet: streaming SSR, resumability, multi-framework islands,
edge/serverless targets, and a local-first data layer. Each was considered and deferred - see
`CLAUDE.md`.

## License

MIT
