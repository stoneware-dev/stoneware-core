# Test fixture app

A deliberately minimal Stoneware app that exists only for the test suite.

Tests assert on exact markup, so they need an app whose content never changes for
editorial reasons. The documentation site lives in its own repository and its copy is rewritten
freely; pointing integration tests at it would mean every wording change breaks a
test, which trains people to edit assertions instead of reading failures.

This fixture covers one of each thing the router and pipeline must handle:

- `routes/index.tsx` — a page using islands, a `<Form>`, and `csrfToken()`
- `routes/plain.tsx` — a page with no islands, to prove zero JS ships
- `routes/blog/[slug].tsx` — a dynamic segment
- `routes/api/echo.ts` — a server action (POST only), for CSRF and 405 coverage
- `islands/Counter.tsx` — island with local state
- `islands/Badge.tsx` — island reading a signal it does not own
- `lib/state.ts` — the shared-signal, cross-island bundling case
