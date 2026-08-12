# kiln

A server-first web framework built natively on Bun. Every route renders to complete HTML.
Interactivity is opt-in per directory. Escaping and CSRF protection are on before you write any
configuration.

**In one line:** Fresh, but Bun-native instead of Deno-native, with a non-component template model.

```
bunx create-kiln my-site
cd my-site
bun install
bun run dev
```

## What it is for

Content-heavy, SEO-sensitive sites - marketing pages, blogs, docs, small business sites - that need a
handful of interactive widgets rather than a single-page app.

If your page is mostly a document, shipping a client runtime to render it is a strange default. Kiln
inverts that: the page is HTML, and the widgets are the exception.

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
[Preact Signals](https://github.com/preactjs/signals) directly, re-exported as `kiln/signals`. Kiln
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
  islands/                 the only place client JS originates
    Counter.tsx
  lib/                     behavior functions, shared utilities
  public/                  static assets, served as-is
  kiln.config.ts
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

## Islands and signals

```tsx
// islands/Counter.tsx
import { signal } from "kiln/signals";

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

Set `KILN_CSRF_SECRET` in production. Without it, a production build refuses to start rather than
falling back to something that appears to work.

## Environment variables

Bun reads `.env`, `.env.local`, and `.env.<mode>` natively, so Kiln has no dotenv dependency -
consistent with the rule that the framework uses Bun's own APIs rather than npm packages that
reimplement them.

`create-kiln` generates a `.env` containing a freshly random `KILN_CSRF_SECRET`, gitignores it, and
leaves `.env.example` as the tracked template:

```
KILN_CSRF_SECRET=<unique per environment>
```

Precedence is `.env.local` over `.env`, and a real environment variable over both - so a deploy
target's own configuration always wins. `PORT` is honored the same way and overrides `port` in
`kiln.config.ts`, which is what `kiln dev --port` sets.

Keep the secret in the environment rather than in `kiln.config.ts`, so it is never committed.
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

## CLI

```
kiln dev     Start the dev server with hot reload
kiln build   Production build (server bundle + island chunks)
kiln start   Run the production server bundle
```

`kiln build` emits one server bundle with every route and island statically imported, plus one
content-hashed chunk per island and a shared runtime chunk.

> **Note:** route modules are inlined into the server bundle, but path *matching* still uses
> `Bun.FileSystemRouter`, so `routes/` must exist at runtime. It is read for its filenames, never for
> its contents.

## Example

`example/` is a blog with three islands, a newsletter signup backed by a server action, and a page
that ships no JavaScript at all.

```
bun run example
```

## Testing

```
bun test
```

Unit tests cover the renderer, the router, and CSRF verification; the client runtime is tested
against a real DOM; and there is one integration test group per milestone, run against `example/`.

## Status

v0.1. Deliberately **not** included yet: streaming SSR, resumability, lazy hydration directives,
multi-framework islands, edge/serverless targets, and a local-first data layer. Each was considered
and deferred - see `CLAUDE.md`.

## License

MIT
