# Architecture

How Stoneware is put together, and why. This is for someone changing the
framework rather than using it — user-facing docs live on the
[documentation site](https://github.com/stoneware-dev/stoneware-docs).

About 8,200 lines of TypeScript across 27 source modules, with 37 test files.
Read `CLAUDE.md` first for the scope boundaries; this describes the mechanism.

---

## 1. The one-sentence version

A request arrives at `Bun.serve`, passes through a fixed pipeline, reaches a
route function that returns JSX, and that JSX is walked **once** to a string.
Nothing is retained between requests except the route table and the island
registry.

There is no VDOM, no reconciler, no diff, and no component instances. A
"component" is a function called once per request.

---

## 2. The request pipeline

Order is the security model. It lives in `src/server.ts`, in `handleRequest`,
and the sequence is deliberate at every step:

```
  Bun.serve
      │
      ├─ /_stoneware/*          built client chunks
      │                         miss falls through to public/
      ├─ public/*               served as-is
      │
      ├─ CORS preflight         answered before verification: no body,
      │                         no token, changes nothing
      │
      ├─ CSRF verification      every non-GET, before anything else
      │                         observes the request
      │
      ├─ routes/_middleware.ts  after CSRF, before matching
      │
      ├─ route match            route-table.ts
      │
      └─ page render │ action handler
      │
      └─ withSecurityHeaders → withCORS → observe
```

Three properties fall out of that order and must survive any change to it:

**CSRF runs before middleware.** Middleware is ordinary project code. Code that
ran ahead of verification could act on a request that was about to be rejected —
which is how a framework acquires a documented way around its own protection.

**Middleware runs before matching.** It therefore also sees requests that are
about to 404, which is what makes a redirect rule for a removed page work.

**Every response leaves through one exit.** `withSecurityHeaders` fills gaps
rather than overwriting, so a route can set its own CSP but cannot forget the
others. A new code path physically cannot skip them.

---

## 3. Module map

| Module | Responsibility |
|---|---|
| `server.ts` | The pipeline above. The only place responses are assembled. |
| `router.ts` | Filename → pattern (via `Bun.FileSystemRouter`), module loading, page/action classification |
| `route-table.ts` | Matching a path against compiled patterns. Own implementation — see §7 |
| `render.ts` | JSX tree → HTML string, island collection, error attribution |
| `jsx-runtime.ts` | `h`/`jsx`/`Fragment`. Builds inert `{type, props}` records, nothing more |
| `types.ts` | `VNode`, `Child`, `Component` vs `PageComponent`. Symbol brands |
| `escape.ts` | `Bun.escapeHTML`, `raw()`, and JSON-in-HTML serialization |
| `attributes.ts` | What an attribute may be. **Shared by both renderers** — see §6 |
| `config.ts` | Resolution and defaults. `DEFAULT_CSP`, `buildCSP` |
| `csrf.ts` / `public-csrf.ts` | `Bun.CSRF` wrapper; the token helper templates call |
| `context.ts` | `AsyncLocalStorage` for the active render |
| `build.ts` | Island chunks and the stylesheet |
| `islands.ts` | Discovery and the component → name registry |
| `document.ts` | `<html>` assembly, CSP meta tag |
| `observe.ts` | The request hook |
| `boundary.tsx` | `<Boundary>` |
| `cli/` | `dev`, `build`, `export`, `preview`, `routes`, `doctor`, `vercel` |
| `client/` | The browser runtime: `hydrate`, `dom`, `registry`, `lazy` |

---

## 4. Rendering

`renderToString(tree)` walks depth-first and appends to a string. Every
interpolated value passes through `Bun.escapeHTML` unless wrapped in `raw()`.

Two things people expect to find and will not:

- **No async components.** Only a route's default export may be async, because
  the server awaits that one call before the walk begins. There is no point
  inside a synchronous walk at which a promise could be resolved. `PageComponent`
  allows it; `Component` does not, and that asymmetry is load-bearing.
- **No inline executable script, ever.** Hydration payloads are JSON in a
  `<script type="application/json">` tag. This is what makes `script-src 'self'`
  a livable default and why no nonce plumbing exists.

### Performance notes

The walk is the hottest code in the framework. Two things were measured and are
easy to undo by accident:

- **Tag and attribute names are classified once and cached** (`MAX_CACHED_NAMES`,
  bounded because a name can come from request data). Re-deriving them per
  occurrence cost ~28% of a page render.
- **Error attribution uses try/catch on components only.** Wrapping every
  *element* cost 38% of a page render. The innermost element is recorded with
  two field writes on the context instead. There is a test asserting intermediate
  elements stay out.

Microbenchmarks lie here — JIT elides isolated try/catch entirely. Measure with a
page-shaped tree.

---

## 5. Islands

A file under `islands/` is the only thing that ships JavaScript.

```
  islands/Counter.tsx
      │
      ├─ server: rendered once into the HTML (no empty flash)
      │          identified by function identity, not a marker
      │
      └─ client: own hashed chunk, hydrated in the browser
```

Identity matters: `render.ts` recognises an island by looking the component
function up in a `Map`, which is why the registry must come from the *build*
rather than from rescanning `islands/` at runtime (see §7).

An island must render exactly one root element — the hydration markers go on it
rather than on a wrapper, so the served HTML gains no extra nodes.

`<Boundary>` and lazy directives (`client:visible`/`idle`/`media`) are handled
in `renderVNode` before the island lookup.

---

## 6. One rule, two renderers

`attributes.ts` is imported by the server renderer *and* the client DOM builder,
and it imports nothing itself because it ships to the browser.

This exists because the two once decided independently and drifted: the handler
pattern was tightened in the renderer and left alone in the client, so an island
was checked on first paint and unchecked on every update afterwards. Same code,
different safety, depending on whether a signal had fired.

Anything answering "is this attribute safe" belongs here. `isSignalLike` lives
here too — it checks the library's `Symbol.for("preact-signals")` brand rather
than `instanceof`, so a second copy of `@preact/signals-core` in a project does
not make every island fail.

---

## 7. Relocatability: the bug family

**The most important thing to understand before changing the build.**

A build runs on one machine and serves on another — a container, a serverless
function, a CI artifact. Four separate bugs came from forgetting that, each
invisible locally because locally the build directory *is* the run directory:

| Version | What was computed at runtime | Symptom |
|---|---|---|
| ≤ 0.1.3 | project root baked in; `routes/` rescanned | 404 on every path |
| 0.1.4 | `.stoneware/islands.json` read from disk | throws at boot |
| 0.1.5 | `stoneware.config.ts` imported by path | **nothing throws** — runs on defaults |
| 0.1.6 | client chunks served from `.stoneware/static` | pages 200, every asset 404 |

The shared cause: **a path computed at runtime is invisible to a bundler that
traces imports.** The rule that follows:

> Anything the served bundle needs must arrive as a static import or an inlined
> value. If code computes a path and reads it, that file will not be there.

So `cli/build.ts` generates a server entry that statically imports every route,
every island, and the config, and inlines the island manifest and stylesheet URL
as values. The root is derived from `import.meta.url`, never from the build cwd.

0.1.5's variant is the one to fear: a missing config file is indistinguishable
from a project that has none, so the app comes up with `csp`, `cors` and
`trustProxy` silently absent.

**Verification method** — used for each fix, and the only one that works:

```
build → copy the output elsewhere → delete routes/, islands/,
        and anything read by a computed path → serve → curl
```

---

## 8. Build outputs

`stoneware build` produces two independent things:

- **one server bundle** (`target: "bun"`), whitespace-minified only. Identifier
  mangling turns a production stack frame into `at e8`, and syntax minification
  constant-folds — which moved the reported line and rewrote an error message.
  Both were measured; the last ~10% is not worth it on a bundle nobody downloads.
- **one client chunk per island** plus a shared runtime chunk, fully minified,
  content-hashed, code-split. These *are* downloaded, and identifiers do not
  matter in them.

That asymmetry is deliberate and documented at the call site.

`stoneware export` runs the same pipeline and writes files. It skips a page that
renders a CSRF token (a frozen token would be handed to every visitor) and a
dynamic route with no `staticPaths()`. It then resolves every internal link in
the output and reports the ones that dangle; `--strict` exits non-zero.

---

## 9. Security invariants

Each of these is enforced by construction rather than by discipline:

- Escaping is the default; `raw()` is the only way out and is deliberately ugly.
- CSRF is verified before any project code runs. There is no per-route opt-in.
- Security headers and CSP are applied at one exit point.
- `public/` refuses dotfiles and, by default, symlinks that resolve outside it
  (checked with `realpathSync`, because a lexical check and the filesystem
  disagree about links).
- `<script>`/`<style>` bodies accept literal strings only. Escaping cannot make
  an arbitrary value safe in those contexts, so interpolation is refused.
- A CSP source containing `;`, `,` or whitespace is rejected — otherwise a value
  from an env var could append a directive.

---

## 10. Development server

`stoneware dev` re-execs under `bun --hot`, which re-evaluates this module graph
on every edit. Two consequences that have each caused a bug:

- **State must live on `globalThis`**, not in module scope. Watchers, sockets,
  and the server are parked there.
- **`Bun.serve` must be called once.** Calling it again per re-evaluation left
  the previous server bound, started a second on the next port, and left the
  browser talking to the *previous* module graph — where every identity check
  failed. It now calls `server.reload()` instead.

`refresh()` takes an argument saying what changed. Rebuilding every island on a
template edit cost ~53 ms per save for no reason.

---

## 11. Testing

`bun test`. Fixtures are directories under `test/`, and the conventions matter:

- **One real `Bun.build` per test run.** Two concurrent builds race on Windows
  reading `signals-core.mjs`. New tests needing a build go in
  `relocatable.test.ts`, which already does one.
- **Assert by effect, not by timing.** The dev-refresh tests delete the build
  output, ask for one refresh, and check what came back.
- **A regression test must be shown to fail.** Every fix in the relocatability
  family was verified by reverting it and watching the test go red.

---

## 12. Where to be careful

- `render.ts` hot path — measure with a page, not a microbenchmark.
- Pipeline order in `server.ts` — see §2.
- Anything touching a path at runtime — see §7.
- `attributes.ts` — changing one side of a rule and not the other is the
  specific mistake it exists to prevent.
- The default CSP — extending it is a config feature; weakening it is not.
