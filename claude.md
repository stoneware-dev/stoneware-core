# CLAUDE.md - Bun-Native SSR Framework ("Stoneware")

> Name settled: **Stoneware**. npm packages `stoneware` (framework) and `create-stoneware`
> (scaffolder).
>
> Naming history: drafted as "Kiln" (taken on npm), then "Sinter" (rejected by npm's
> typosquat filter as too close to `sonner`). Stoneware is clay fired until it
> vitrifies into a single dense body — what the framework does to templates at
> build/server time — and it was already the documentation site's design language
> ("celadon on stoneware"). Verified to have zero packages within one edit.

## 1. What this is

A server-first web UI framework built natively on Bun (not Node-compatible-via-Bun). Static HTML by
default, islands for interactivity, signals for reactivity inside islands, security defaults baked in.

**One-line pitch:** "Fresh, but Bun-native instead of Deno-native, with a non-component template model."

**Who it's for:** developers building content-heavy, SEO-sensitive sites (marketing pages, blogs, docs,
SMB sites) who want a handful of interactive widgets, not a full SPA.

## 2. Core design principles (non-negotiable for v0.1)

1. **Server-first.** Every route renders to complete HTML by default. No client JS unless a component
   is explicitly marked as an island.
2. **No component model.** No classes, no hooks, no `useState`. Templates are plain functions that take
   props and return markup. Logic lives in separate "behavior" functions, not inside UI definitions.
3. **Signals, not a custom reactivity engine.** Reuse **Preact Signals** (`@preact/signals-core`) as the
   dependency graph / reactivity primitive. Do NOT implement a new graph-based reactive engine. This is
   the single most important scope boundary in this project - revisit only after v0.1 ships and is used
   by someone other than the author.
4. **Islands are opt-in, not default.** A component only ships JS to the client if explicitly marked.
5. **Security is on by default, not opt-in.** Auto-escaping and CSRF protection require no configuration
   to get the safe behavior; unsafe behavior requires an explicit escape hatch.
6. **Everything routes through Bun's own APIs**, not npm packages that reimplement what Bun already
   ships. Use `Bun.serve`, `Bun.build`, `Bun.escapeHTML`, `Bun.CSRF`, `Bun.file`, `Bun.$` where they
   cover the need.

## 3. Explicit non-goals for v0.1 (do not build these yet)

These were considered and deliberately deferred. Do not implement them without an explicit go-ahead:

- ❌ Custom graph-based reactivity engine (use Preact Signals instead)
- ❌ Resumability / Qwik-style zero-hydration event serialization
- ❌ A "control panel" / admin dashboard shipped with the framework
- ❌ SQL-like / local-first live query data layer (Zero/ElectricSQL-style sync engine)
- ❌ Multi-framework island support (React/Vue/Svelte components as islands) - single template
  language only for v0.1
- ❌ Streaming SSR - full HTML response only for v0.1
- ❌ Edge/serverless compile targets
- ❌ DevTools browser extension

If a task seems to require one of these, stop and flag it rather than building it inline.

## 4. Tech stack

| Concern              | Choice                                                    |
|-----------------------|------------------------------------------------------------|
| Runtime                | Bun (latest stable)                                        |
| Language                | TypeScript, native Bun transpilation, no separate tsconfig gymnastics |
| Template syntax         | `.stoneware.tsx` - JSX syntax, function-only, no class/hook APIs |
| Reactivity (islands only) | `@preact/signals-core` (small, MIT, battle-tested)      |
| HTTP server              | `Bun.serve()`                                              |
| Bundler                   | `Bun.build()` - separate server bundle and per-island client bundles |
| Escaping                    | `Bun.escapeHTML()` - auto-applied in template interpolation |
| CSRF                          | `Bun.CSRF` - auto-injected into `<form>` helper, auto-verified in action handler |
| Test runner                     | `bun test`                                              |
| Package manager                   | `bun install`                                         |

## 5. Directory structure (of a project using the framework)

```
my-site/
  routes/                 # file-based routing, server-only by default
    index.stoneware.tsx
    blog/[slug].stoneware.tsx
    api/subscribe.ts       # server action / API route
  islands/                 # ONLY place client JS is allowed to originate
    Counter.stoneware.tsx
    NewsletterForm.stoneware.tsx
  lib/                       # behavior functions (non-UI logic), shared utils
  public/                     # static assets, served as-is
  stoneware.config.ts                # framework config (port, csp, etc.)
```

Convention mirrors Fresh's `routes/` vs `islands/` split: if it's in `islands/`, it hydrates. If it's
in `routes/`, it's server-only HTML, no exceptions, no per-file directive needed.

## 6. Template syntax & compilation

- Templates are `.stoneware.tsx` files exporting a default function: `(props) => JSX.Element`.
- No hooks. No lifecycle methods. State that needs to be reactive on the client must live in an
  `islands/` file and use signals explicitly - plain functions elsewhere are pure render functions,
  called once per request on the server.
- Compilation: Bun's native JSX/TSX transpilation handles parsing. A thin custom JSX runtime (`h`,
  `Fragment`) renders directly to an HTML string server-side (no VDOM, no diffing - this is a
  render-once-to-string operation, not a reconciler).
- All interpolated values go through `Bun.escapeHTML()` by default. Raw/unescaped output requires an
  explicit `raw()` wrapper - this should feel deliberately inconvenient to discourage casual use.

## 7. Routing

- File-based, mirrors Next.js/Astro conventions developers already know (lowest-friction choice):
  - `routes/index.stoneware.tsx` → `/`
  - `routes/blog/[slug].stoneware.tsx` → `/blog/:slug`
  - `routes/api/*.ts` → API/action routes, no HTML rendering, exports `POST`/`GET`/etc. handlers
- Router resolves the request, calls the matched template function with `{ params, request }`, gets
  back JSX, renders to an HTML string, returns via `Bun.serve()`.

## 8. Islands & reactivity

- Any file under `islands/` is:
  1. Server-rendered once for the initial HTML response (so there's no flash of empty content), AND
  2. Bundled separately via `Bun.build()` into its own small client chunk, AND
  3. Hydrated client-side. Eager by default; `client:visible`, `client:idle` and `client:media`
     shipped after v0.1 and live in `src/client/lazy.ts`.
- Inside an island, state is declared with signals:
  ```tsx
  // islands/Counter.stoneware.tsx
  import { signal } from "@stoneware/signals"; // thin re-export of @preact/signals-core

  const count = signal(0);

  export default function Counter() {
    return (
      <button onClick={() => count.value++}>
        Count: {count}
      </button>
    );
  }
  ```
- Shared state between multiple islands on the same page: export a signal from a shared module and
  import it in both islands (same pattern Fresh documents for cross-island signals).

## 9. Server actions

- Any exported `POST`/`PUT`/`DELETE` handler in `routes/api/*.ts` is a server action.
- Forms use a `<Form action="/api/subscribe">` helper (not raw HTML `<form>`) that automatically
  injects a CSRF hidden field via `Bun.CSRF.generate()`.
- The framework's request-handling layer automatically verifies the CSRF token on any non-GET request
  before the handler runs - this is not something the developer opts into per-route.

## 10. Security defaults (baked in, not configurable off by accident)

- Auto-escape all template interpolation (`Bun.escapeHTML`).
- Auto CSRF on all mutating requests (`Bun.CSRF`).
- Default `Content-Security-Policy` header set by the framework, overridable in `stoneware.config.ts` but
  never silently absent.
- No inline `<script>` injection from user data, ever - hydration payloads are JSON-serialized and
  escaped, not string-concatenated into script tags.

## 11. Build pipeline

1. `bun build` compiles `routes/**/*.stoneware.tsx` into a single server bundle (SSR render functions).
2. `bun build` separately compiles each `islands/**/*.stoneware.tsx` into its own client-only chunk
   (tree-shaken, no server-only code included).
3. Output: one server bundle + N small island bundles, referenced by hashed filename in the rendered
   HTML's `<script>` tags.

## 12. Dev server

- `bun --hot` for the server bundle (fast server-side iteration).
- File watcher triggers island rebuild + browser reload on change to `islands/`.
- No separate dev-server process needed - `Bun.serve()` handles both HTML responses and serving the
  built client chunks from memory/disk in dev mode.

## 13. CLI (build last, after core works)

- `bunx create-stoneware my-site` - scaffolds the directory structure above.
- `stoneware dev` - starts dev server with hot reload.
- `stoneware build` - production build (server + island bundles).
- `stoneware start` - runs the production server bundle.

## 14. v0.1 milestone scope (target: a few weeks, solo)

Ship in this order - each step should be independently demoable:

1. **Static-only SSR**: file router + template compiler, zero interactivity, zero islands. A working
   static site generator, essentially. Prove the render pipeline first.
2. **Islands, eager hydration**: mark a component in `islands/`, get it bundled and hydrated on load.
3. **Signals wired in**: island state via `@preact/signals-core`, confirm cross-island shared signals
   work.
4. **Server actions + CSRF**: one working form → POST → CSRF verified → response.
5. **Security defaults locked in**: escaping and CSP confirmed on by default with no config.
6. **CLI scaffold + docs**: `create-stoneware`, a README, and one worked example (e.g., a blog with a
   newsletter-signup island) - this is what you show people to get first feedback.

All six shipped. Lazy hydration directives followed. Do not start on multi-framework islands or
anything from Section 3 without an explicit go-ahead.

## 14a. Shipped since v0.1

- **Lazy hydration** — `client:visible`, `client:idle`, `client:media`.
- **`sitemap()` / `sitemapXML()`** (0.2.0). Composable: it owns XML correctness and refuses to guess
  which of your routes belong in a sitemap, because that is an editorial decision.
- **Multi-process serving** (0.2.0). `workers` in config, `--workers`, `WEB_CONCURRENCY`. Linux only
  and it says so: `reusePort` is accepted everywhere and load-balances only on Linux — measured on
  Windows, where the first process to bind receives every connection. Workers share nothing, which is
  why the CSRF secret must keep coming from the environment.
- **Static path index and asset metadata cache** (0.2.0). Halves the framework's per-request cost.
  It does not measurably change end-to-end throughput, because the framework is roughly a seventh of
  an HTTP request — do not claim otherwise. The p99 over HTTP is Bun's, not the framework's.

Two measurements worth not re-deriving: `renderToString` is ~21µs for a 14 KB document, and the whole
framework request path is ~0.07ms in process. Rendering has never been the cost.

## 15. Testing

- `bun test` for unit tests on the template compiler, router matching, and CSRF verification logic.
- One integration test per milestone: request in → expected HTML string out.

## 16. Open decisions (resolve before/at implementation start, not mid-build)

Resolved at implementation start, 2026-08-12:

- [x] **Final project name** - `stoneware`. Package `stoneware`, CLI binary `stoneware`, scaffold `create-stoneware`.
      Chosen after `kiln` was found to be taken on npm (an abandoned 2022 package, v0.0.1). Both
      `stoneware` and `create-stoneware` were verified available. Repo: github.com/stoneware-dev/stoneware-core.
- [x] **License** - MIT.
- [x] **File extension** - plain `.tsx`, directory convention only. The custom `.stoneware.tsx` extension
      was dropped: it bought no behavior the `routes/` vs `islands/` split does not already provide,
      and it would have required mapping a double extension in editors, tsserver, and the Bun loader.
      This supersedes the `.stoneware.tsx` references in §4 and §6.
- [x] **Minimum Bun version** - `>=1.3.0`, pinned in `engines`. Chosen as the floor actually verified
      (developed and tested against 1.3.14). `Bun.CSRF` landed earlier than this, so the real floor is
      likely lower; lower it only after testing against a specific older release.

One convention not in the original spec, settled during implementation:

- **Islands must render exactly one HTML element at their root.** The hydration markers are written
  onto that element rather than a wrapper, which keeps the served HTML free of extra nodes and avoids
  any layout impact. Violations raise an explicit error at render time.
