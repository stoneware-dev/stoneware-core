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

## Documentation

Full documentation lives on the Stoneware docs site, which is itself built with Stoneware:

**→ [Read the documentation](https://github.com/RANJEETJ06/stoneware-docs)**

It covers the [full benchmark](https://github.com/RANJEETJ06/stoneware-docs), routing, islands and signals, hydration directives (`client:visible`, `client:idle`,
`client:media`), co-located CSS, head metadata, `seo()` and `<Image>`, middleware, server actions and CSRF, security
defaults, error pages, caching, the CLI, and deploying — including static export to hosts that
cannot run Bun.

## Benchmark

A 16-page portfolio and blog, built three times with matching content and the
same five interactive components. Lighthouse mobile throttling (1638 Kbps,
150 ms RTT, 4x CPU), 10 runs per page, median.

| | Stoneware | Astro 5.18 | Next.js 15.5 |
|---|---|---|---|
| JS transferred | **14.2 KB** | 193.1 KB | 346.0 KB |
| HTML | **3.4 KB** | 8.1 KB | 10.2 KB |
| Total transferred | **22.5 KB** | 205.2 KB | 359.4 KB |
| Requests | 8 | 8 | **7** |
| **LCP** | **1217 ms** | 2253 ms | 2965 ms |
| FCP | 1062 ms | 1429 ms | **754 ms** |
| Total blocking time | **0 ms** | **0 ms** | 58 ms |
| Lighthouse performance | **100** | 99 | 95 |
| Build (16 pages, cold) | **0.71 s** | 35.6 s | 61.6 s |

**JavaScript is the whole story.** All three score CLS 0.000 and TTFB of 1-3 ms,
so layout stability and server latency are noise. What separates them is
**13.6x and 24.4x more JavaScript** for the same five islands.

Astro's LCP is almost perfectly flat at ~2253 ms whether a page carries 426 or
3,367 bytes of content, and Next.js the same at ~2960 ms - the client runtime is
a fixed cost on the critical path, so page weight barely matters beside it.
Stoneware is the only one whose LCP tracks the page (909-1512 ms), because there
is no fixed cost to dominate it.

Two results worth stating plainly: **Next.js wins FCP** by inlining more of the
critical path - fast first paint, then a ~2.2 s wait for the JavaScript that
makes it useful. And **a perfect score is not discriminating**: 100 / 99 / 95
would all pass a casual audit while hiding a 24x spread in JavaScript shipped.

> **Read the numbers fairly.** Bytes are uncompressed; production would compress
> all three, which narrows transfer but not parse-and-execute time. The build
> column is not like-for-like either - `stoneware build` emits a server bundle
> while Astro and Next.js prerender 16 HTML files; the comparable command is
> `stoneware export`, at 0.63 s. Build timing was also the noisiest metric
> measured, so treat the ordering as the result and the absolute values as
> indicative.

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
require no configuration to get the safe behavior. The unsafe path requires typing more.

## Project layout

```
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

```
stoneware dev     Start the dev server with hot reload
stoneware build   Production build (server bundle + island chunks)
stoneware start   Run the production server bundle
stoneware export  Prerender every page to static HTML
```

## Requirements

Bun >= 1.3.0. The framework is built on `Bun.serve`, `Bun.build`, `Bun.escapeHTML`, `Bun.CSRF` and
`Bun.FileSystemRouter` - it is Bun-native, not Node-compatible-via-Bun.

## Contributing

The documentation site lives in its own repository,
[stoneware-docs](https://github.com/RANJEETJ06/stoneware-docs). It consumes `stoneware`
from npm exactly as any other project does, so it cannot quietly depend on unreleased behaviour.

```sh
bun install
bun test
```

## Status

v0.1. Deliberately **not** included yet: streaming SSR, resumability, multi-framework islands,
edge/serverless targets, and a local-first data layer. Each was considered and deferred - see
`CLAUDE.md`.

## License

MIT
