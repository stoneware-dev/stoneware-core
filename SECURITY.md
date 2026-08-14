# Security policy

Stoneware's premise is that the safe behaviour is the default one — auto-escaping,
CSRF verification, and a Content-Security-Policy you have to opt *out* of. A hole in
any of those is worth reporting, and this is how.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private vulnerability reporting on the repository:

> **Security** → **Report a vulnerability**
>
> <https://github.com/stoneware-dev/stoneware-core/security/advisories/new>

That opens a private thread visible only to the maintainers. If you cannot use it,
open a public issue containing **only** the words "security report, please make
contact" and no details, and you will be contacted to move somewhere private.

Please include, as far as you have them:

- what an attacker can do, and what they need in order to do it
- a minimal reproduction — a route, a template, a request
- the Stoneware and Bun versions — `stoneware --version` prints both
- whether it reproduces on a project created by `create-stoneware`

A proof of concept is welcome but not required. A clear description of the mechanism
is worth more than a working exploit.

## What to expect

| Stage | Target |
| --- | --- |
| First reply | within 5 days |
| Assessment and severity | within 14 days |
| Fix for a confirmed high-severity issue | in the next release |

This is a solo, pre-1.0 project. Those are the targets, not a contractual SLA, and
you will be told plainly if something is going to take longer.

You will be credited in the advisory and the release notes unless you ask not to be.
There is no bounty programme.

## Supported versions

Only the latest published version receives fixes. Pre-1.0 releases are not
backported.

| Version | Supported |
| --- | --- |
| latest `0.1.x` | ✅ |
| anything older | ❌ upgrade |

## Scope

**In scope** — anything that defeats a defence the framework claims to provide:

- output that escapes its context: a value reaching HTML, an attribute, or a URL
  unescaped, or `raw()` being reachable without the author writing it
- CSRF verification being bypassed, skipped for a mutating request, or satisfied by
  a token the requester should not be able to obtain
- the default CSP or the security headers being absent, weakened, or bypassable
- path traversal or symlink escape in static file serving
- a secret reaching the client: an environment variable inlined into an island
  chunk, or server-only data serialised into a hydration payload
- a request that can crash or hang the server — including one that reaches a
  runtime panic underneath, since an uncatchable abort is still a denial of service
- anything in the build that lets one project's files reach another's output

**Out of scope:**

- vulnerabilities in Bun itself — report those to <https://github.com/oven-sh/bun>.
  Report them here too if Stoneware can be made to trigger one from a request, which
  makes it our problem as well as theirs
- a project that has explicitly disabled a defence (`csp: false`, `followSymlinks:
  true`, `trustProxy: true` without a proxy, `raw()` on user input) and is bitten by
  the thing that setting turns off. The escape hatches are deliberate and documented
- missing hardening with no attack behind it — a header you would prefer to see set
  is a feature request, not a vulnerability
- findings from an automated scanner pasted without a reproduction

## Known weaknesses

Documented rather than hidden, because knowing where the edges are is part of using
this safely.

- **CSRF tokens are not bound to a session.** A token proves it was issued by this
  application and has not expired. It does not prove it was issued to the browser
  presenting it, so an attacker with an account can obtain a valid token. This stops
  cross-site forgery, which is what CSRF protection is for; it is not an
  authorisation check.
- **`trustProxy` is off by default and unsafe to enable without a proxy.** With it
  on, `X-Forwarded-Host` is trusted — and anyone who can reach the app directly can
  forge it, poisoning every absolute URL the app emits.
- **Pre-1.0.** The security model has been reviewed repeatedly but has not been
  exercised by anyone outside the project. Treat it accordingly.
