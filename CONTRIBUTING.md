# Contributing

Stoneware is open to contributions, and the fastest way to help is usually not code.

The framework is young and deliberately small. Most of what makes it better right now is
people using it and reporting what broke, what was confusing, or what the documentation
claimed and the code did not do.

## The quickest ways to help

You do not need permission for any of these — open an issue and go.

- **Report a bug.** A failing case with the smallest project that reproduces it is worth
  more than a patch, because it becomes a regression test.
- **Report a documentation error.** If a page says something the code does not do, that is
  a bug of the same severity as a broken function. Quote the line.
- **Say what confused you.** "I could not work out how to X" is a real report. Being new to
  the framework is a perishable skill and it is the only way to find these.
- **Propose a test.** Missing coverage on something you rely on is a legitimate issue.

## How pull requests work here

**Pull requests are limited to repository collaborators.** That is unusual, so it deserves
an explanation rather than a rule.

Stoneware is maintained by one person, and its value comes mostly from what it refuses to
include. A framework this small stays coherent only if every addition is weighed against
the whole design, and reviewing a finished pull request is the worst moment to have that
conversation — by then someone has spent their evenings on it, and "this does not fit"
lands as a rejection of the work rather than a decision about scope.

So the design conversation happens first, in the open, before anyone writes code they
might have to throw away.

### The path for a change

1. **Open an issue or a discussion** describing the problem you hit. Lead with the problem,
   not the solution — the fix you have in mind may not be the one the framework needs.
2. **Fork and build it** if you want to. Working code makes a proposal much easier to
   evaluate, and your fork is yours regardless of what happens next.
3. **Share what you built** on that issue: a link to your branch, what it changes, and what
   it cost. Screenshots, benchmark numbers and failing-then-passing tests all help.
4. **The approach gets reviewed** against the project's direction. Expect questions about
   scope and maintenance burden more than about style.
5. **If it fits, you will be invited as a collaborator** and can open the pull request.

For small, obvious things — a typo, a broken link, a missing test, an error message that
misleads — say so in an issue and it will usually be handled quickly, either by you once
invited or by the maintainer directly. Do not sit on a one-line fix waiting for process.

## What makes a proposal easy to say yes to

- **It solves a problem someone actually hit.** A real report beats a hypothetical.
- **It is smaller than it could be.** The narrow version that solves the real case is
  almost always better than the general one that anticipates four more.
- **It keeps the safe path the default one.** Escaping, CSRF verification and the CSP are
  on before any configuration. A change that makes the unsafe thing easier needs a strong
  argument.
- **It uses Bun's own APIs.** `Bun.serve`, `Bun.build`, `Bun.escapeHTML`, `Bun.CSRF`,
  `Bun.file`. Adding a dependency that reimplements something the runtime already ships is
  the fastest way to a no. There is currently exactly one runtime dependency and that is a
  number worth defending.
- **It comes with a test.** Framework behaviour that is not asserted somewhere will be
  broken by accident later.
- **It says what it costs.** Bundle size, request time, a new failure mode, a new thing to
  document. Every feature has a price; naming it makes the trade-off discussable.

## What is deliberately out of scope

These have been considered and set aside. They are not oversights, and building one
speculatively is likely to waste your time:

- A custom reactivity engine. Islands use Preact Signals, and that boundary is the single
  firmest scope decision in the project.
- Resumability / zero-hydration event serialisation.
- Multi-framework islands — React, Vue or Svelte components as islands.
- Streaming SSR.
- A local-first sync engine or query layer.
- An admin dashboard shipped with the framework.
- A DevTools browser extension.

If you think one of these has become the right call, that is a discussion worth having —
open one and make the case. Just do not open it with the implementation already finished.

## Working on the code

```sh
git clone https://github.com/stoneware-dev/stoneware-core.git
cd stoneware-core
bun install

bun test              # 46 test files
bun run typecheck     # tsc --noEmit
```

Both must pass. `prepublishOnly` runs them together, so a failure here is a failure at
release.

A few conventions that will save you a review round:

- **Bun >= 1.3.0.** That is the floor in `engines` and the version the suite is verified
  against. Do not raise it without a reason that names the API you need.
- **Tests live in `test/`**, one file per concern, with fixtures in `test/fixture*/`.
  Prefer `createApp()` and `app.fetch(request)` over starting a server — request in,
  response out, no port to bind and nothing to tear down.
- **Comments explain why, not what.** The existing code is heavy on rationale and light on
  narration; a comment that says what the next line does will be asked about.
- **Measure before claiming.** If a change is described as faster or smaller, the number
  and the method belong in the issue. Several things in this project were reverted after
  the measurement disagreed with the intuition.

## Reporting a security issue

Do not open a public issue. See [SECURITY.md](SECURITY.md) — use GitHub's private
vulnerability reporting.

## Licence

Stoneware is MIT. Contributions are accepted under the same licence.
