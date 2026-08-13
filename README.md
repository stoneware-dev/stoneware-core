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

It covers routing, islands and signals, hydration directives (`client:visible`, `client:idle`,
`client:media`), co-located CSS, head metadata, `seo()` and `<Image>`, server actions and CSRF, security
defaults, error pages, caching, the CLI, and deploying — including static export to hosts that
cannot run Bun.

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
[RANJEETJ06/stoneware-docs](https://github.com/RANJEETJ06/stoneware-docs). It consumes `stoneware`
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
