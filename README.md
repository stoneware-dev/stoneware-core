# stoneware

**A Bun-native, server-first web framework where HTML is the default and JavaScript is opt-in.**
Build content-heavy sites without shipping a client runtime to pages that do not need one.

The web sends a lot of JavaScript to sites that are mostly documents. Stoneware inverts the default: every
route renders to complete HTML, and a component ships JavaScript only if you put it in `islands/`.
Escaping, CSRF verification, and a strict CSP are on before you write any configuration.

Measured on this repo's own documentation site, in production:

| | |
| --- | --- |
| Whole client runtime (signals + hydrate + DOM) | ~3.4 KB gzipped |
| One island (the counter on the home page) | ~0.2 KB gzipped |
| A page with no islands | **0 bytes, no script tag** |
| Runtime dependencies | **1** (`@preact/signals-core`) |

## Try Stoneware in 60 seconds

```bash
bunx create-stoneware my-site   # npx create-stoneware my-site works too
cd my-site
bun install
bun run dev
```

Then open <http://localhost:3000>.

Scaffolding runs on plain Node, so `npx` works before Bun is installed. Everything after that — the
dev server, the build — runs on Bun, and `stoneware` says so with an install link if Bun is missing.

## Documentation

Full documentation lives on the Stoneware docs site, which is itself built with Stoneware — so
every claim on it is running the code it describes.

**→ [Read the documentation](https://stoneware-docs-1lob.onrender.com/docs)**

Routing and catch-all patterns, components, islands and signals, hydration directives
(`client:visible`, `client:idle`, `client:media`), co-located CSS, head metadata, `seo()` and
`<Image>`, middleware, server actions and CSRF, security defaults, error pages and boundaries,
caching, testing, configuration, the API reference, the CLI, and deploying — including static
export to hosts that cannot run Bun.

- [Quick start](https://stoneware-docs-1lob.onrender.com/docs/quick-start)
- [How it works](https://stoneware-docs-1lob.onrender.com/docs/how-it-works) — the request pipeline and the render model
- [Full benchmark](https://stoneware-docs-1lob.onrender.com/docs/benchmark) — both studies, with the run they came from
- [Writing](https://stoneware-docs-1lob.onrender.com/blogs) — longer posts on the decisions behind it

The site's source is its own repository,
[stoneware-docs](https://github.com/stoneware-dev/stoneware-docs). It installs `stoneware` from
npm exactly as any other project does, so it cannot quietly depend on unreleased behaviour.

## Benchmark

Twenty articles and an index — 42,871 words — built three times from a byte-identical
`content.json`, through a byte-identical stylesheet, into byte-identical markup, then measured
over HTTP against each framework's own production server.

Stoneware 0.2.0 · Astro 7.2.2 · Next.js 16.3.1 (App Router)

| | Stoneware | Astro | Next.js |
| --- | --- | --- | --- |
| JavaScript on an article page | **0 B** | **0 B** | 576 KB |
| Pages shipping no JavaScript | **20 of 21** | **20 of 21** | 0 of 21 |
| JavaScript, whole site, gzipped | 4.8 KB | **0.3 KB** | 255.3 KB |
| HTML, whole site, gzipped | 60.3 KB | **59.4 KB** | 112.7 KB |
| Peak memory during build | **88 MB** | 356 MB | 1143 MB |
| Time to first byte, p50 | **1.13 ms** | 1.74 ms | 1.84 ms |
| Requests/sec at 100 connections | **2236** | 1984 | 920 |

**Astro wins two rows and the table says so.** A plain `<script>` tag beats a hydrated island
for one text box, and 0.3 KB against 4.8 KB is not close — that 4.8 KB is signals plus the
hydration runtime, which is the price of the island model rather than an inefficiency in it.

Next.js sends 576 KB of JavaScript to a page with no interactive element on it, and its HTML is
two and a half times larger because 23.4 KB of the document is the article re-encoded as an
inline RSC payload — the content going out a second time.

> **Read it fairly.** Every figure comes from one named run; sizes are deterministic between
> runs and timings are not, so the tail is deliberately absent here. Build *time* is omitted for
> the same reason it should be: `stoneware build` emits a server bundle while the others
> prerender 21 files, so the comparison is not like-for-like. The load generator shares a
> machine with the server, which makes throughput a floor rather than a ceiling.

The [full study](https://stoneware-docs-1lob.onrender.com/docs/benchmark) has the complete
tables, the second study on what a browser experiences under Lighthouse throttling, and the run
each number was taken from.

## The five decisions that define it

**1. Server-first.** Every route renders to a complete HTML string on the server. A page with no
islands ships zero bytes of JavaScript - not a small runtime, not a hydration shim, nothing.

**2. No component model.** Templates are plain functions: props in, markup out. No classes, no hooks,
no `useState`, no lifecycle.

**3. Signals, not a bespoke reactivity engine.** Islands use
[Preact Signals](https://github.com/preactjs/signals) directly, re-exported as `stoneware/signals`.
Stoneware does not implement a reactive graph. That is a deliberate scope boundary, not an oversight.

**4. Islands are opt-in by location.** A file under `islands/` hydrates. A file under `routes/` never
does. There is no per-file directive to remember and no way to make a page interactive by accident.

**5. Security is on by default.** Auto-escaping, automatic CSRF verification, and a restrictive CSP
require no configuration to get the safe behavior. The unsafe path requires typing more - `raw()` and
`dangerouslySetInnerHTML` are both named to be greppable. Server and client share one module deciding
what an attribute may be, so a `javascript:` URL is refused on first paint *and* on every update.

## Project layout

```text
my-site/
  routes/                  file-based routing, server-only
    index.tsx              -> /
    blog/[slug].tsx        -> /blog/:slug
    api/subscribe.ts       -> server action (POST/PUT/DELETE handlers)
    _404.tsx               -> shown for any unmatched path (optional)
  islands/                 the only place client JS originates
    Counter.tsx
  lib/                     behavior functions, shared utilities
  public/                  static assets, served as-is
  stoneware.config.ts
```

## CLI

```text
stoneware dev     Start the dev server with hot reload
stoneware build   Production build (server bundle + island chunks)
stoneware start   Run the production server bundle
stoneware export  Prerender every page to static HTML

stoneware build --target vercel   Also emit Vercel's Bun-preset entrypoint
stoneware start --workers 4       Serve from four processes sharing one port
```

## Serving from more than one process

One process by default. `--workers N`, `WEB_CONCURRENCY=N`, or `workers: N` in
`stoneware.config.ts` runs N processes behind a shared port, and `"auto"` uses one per core.

```sh
stoneware start --workers 4
```

**Linux only, and it says so.** `reusePort` is accepted by `Bun.serve` everywhere and only
load-balances on Linux — on Windows two processes bind the same port and the first receives every
connection. On any platform where that is true the count falls back to 1 and prints why, because
N processes serving from one of them is worse than one process, and invisible.

Workers share nothing. A counter or cache in a module-level variable becomes one copy per worker,
and consecutive requests from one visitor may be answered by different ones. The CSRF secret is
unaffected because it comes from the environment and is therefore identical in every worker —
which is exactly why it has to keep coming from there.

## Requirements

Bun >= 1.3.0. The framework is built on `Bun.serve`, `Bun.build`, `Bun.escapeHTML`, `Bun.CSRF` and
`Bun.FileSystemRouter` - it is Bun-native, not Node-compatible-via-Bun.

## Contributing

Bug reports, documentation corrections and "this confused me" are all welcome, and none of them
need permission — open an issue.

**Pull requests are limited to repository collaborators.** The design conversation happens first,
on an issue, so nobody spends their evenings on a change that turns out to be out of scope. If an
approach fits, you are invited as a collaborator and open the PR then.
[CONTRIBUTING.md](CONTRIBUTING.md) has the full path, what makes a proposal easy to accept, and
what is deliberately out of scope.

How the framework is put together — the request pipeline, the render model, and the reasoning
behind the parts that are easy to undo by accident — is in [ARCHITECTURE.md](ARCHITECTURE.md).

```sh
bun install
bun test          # 46 test files
bun run typecheck
```

## Status

v0.2.0. Deliberately **not** included yet: streaming SSR, resumability, multi-framework islands,
edge runtime targets, and a local-first data layer. Each was considered and deferred — see
[`claude.md`](claude.md).

Resumability in particular is not on the roadmap and the word is not used loosely here: islands are
server-rendered and then hydrated, which means the island component runs again on the client. What
Stoneware does is keep that scoped — a page with no islands executes no client code at all.

## License

MIT
