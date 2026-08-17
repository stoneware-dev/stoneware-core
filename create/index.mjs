#!/usr/bin/env node
/**
 * `npx create-stoneware my-site` / `bunx create-stoneware my-site`
 *
 * Plain JavaScript with a Node shebang, and deliberately so: this is the one
 * command someone runs *before* they have Stoneware, and possibly before they have
 * Bun. Requiring Bun to create the project would put the runtime requirement in
 * front of the thing that explains the runtime requirement.
 *
 * Nothing here touches a `Bun.*` API, so the same file runs under both. The
 * generated project is Bun-only - `stoneware dev` and friends need it - and this
 * script says so on the way out if Bun is missing.
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

const files = {
  "package.json": (name) =>
    JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        scripts: { dev: "stoneware dev", build: "stoneware build", start: "stoneware start" },
        dependencies: { stoneware: "^0.1.7" },
        devDependencies: { "@types/bun": "^1.3.0" },
        engines: { bun: ">=1.3.0" },
      },
      null,
      2,
    ) + "\n",

  "tsconfig.json": () =>
    JSON.stringify(
      {
        compilerOptions: {
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "bundler",
          moduleDetection: "force",
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          noEmit: true,
          jsx: "react-jsx",
          jsxImportSource: "stoneware",
          strict: true,
          skipLibCheck: true,
          types: ["bun"],
        },
      },
      null,
      2,
    ) + "\n",

  "stoneware.config.ts": () => `import { defineConfig } from "stoneware";

export default defineConfig({
  port: 3000,
  // Uncomment behind a proxy that terminates TLS (Render, Railway, Fly, nginx)
  // so request URLs report https://. "proto" trusts only the scheme, which is
  // safe anywhere; true also trusts the forwarded host, so use it only when
  // something you control sets that header.
  // trustProxy: "proto",
  // The framework's default Content-Security-Policy applies unless you replace
  // it here. The CSRF secret comes from STONEWARE_CSRF_SECRET in .env - keep it out
  // of this file so it is never committed.
});
`,

  ".gitignore": () =>
    [
      "# Dependencies",
      "node_modules/",
      "",
      "# Build output. `stoneware build` writes here; deleting it is always safe.",
      ".stoneware/",
      "",
      "# Client chunks copied here by `stoneware build --target vercel`, so the",
      "# platform ships them. Build output, not source - rewritten every build.",
      "public/_stoneware/",
      "",
      "# Secrets. Bun loads .env files natively, so they never reach the repo.",
      "# .env.example is the tracked template and must stay tracked.",
      ".env",
      ".env.*",
      "!.env.example",
      "",
      "# Logs",
      "*.log",
      "",
      "# TypeScript incremental cache",
      "*.tsbuildinfo",
      "",
      "# Editors and OS cruft",
      ".vscode/",
      ".idea/",
      ".DS_Store",
      "Thumbs.db",
      "",
      "# Note: bun.lock is deliberately NOT ignored. Commit it so installs are",
      "# reproducible.",
      "",
    ].join("\n"),

  // Generated with a real secret so `bun run dev` starts clean, and so nobody is
  // tempted to paste a placeholder into production. Bun reads .env natively, so
  // there is no dotenv dependency.
  ".env": () => `STONEWARE_CSRF_SECRET=${randomUUID()}${randomUUID()}\n`,

  ".env.example": () => `# Copy to .env and set a unique value per environment.
# Signs CSRF tokens: rotating it invalidates every form currently rendered.
STONEWARE_CSRF_SECRET=

# Public origin, used for canonical URLs and the sitemap. No trailing slash.
SITE_URL=

# Set to 1 (or "proto") when something terminates TLS in front of the app, so
# request URLs report https:// rather than the forwarded http://.
STONEWARE_TRUST_PROXY=
`,

  "routes/index.tsx": () => `import type { PageProps } from "stoneware";
import Counter from "../islands/Counter.tsx";

export default function Home(_props: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Welcome to stoneware</title>
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" href="/mark.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main>
          <h1>It renders on the server</h1>
          <p>
            This page is complete HTML. Edit <code>routes/index.tsx</code> and it reloads.
          </p>
          <p>The button below is an island - the only JavaScript on this page.</p>
          <Counter />
        </main>
      </body>
    </html>
  );
}
`,

  // A file under routes/ whose name starts with "_" is a convention, not a
  // page: this is never servable at /_404. Delete it and the built-in page
  // takes over.
  "routes/_404.tsx": () => `import type { ErrorPageProps } from "stoneware";

export default function NotFound({ url }: ErrorPageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Not found</title>
        <link rel="icon" href="/favicon.ico" sizes="32x32" />
        <link rel="icon" href="/mark.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <main>
          <h1>Not found</h1>
          <p>
            Nothing is published at <code>{url.pathname}</code>.
          </p>
          <p>
            <a href="/">Back to the home page</a>
          </p>
        </main>
      </body>
    </html>
  );
}
`,

  "islands/Counter.tsx": () => `import { signal } from "stoneware/signals";

// Module-scope state is shared by every Counter on the page. For per-instance
// state, create the signal inside the function.
const count = signal(0);

export default function Counter() {
  return (
    <button type="button" onClick={() => count.value++}>
      Clicked {count} times
    </button>
  );
}
`,

  "public/mark.svg": () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Stoneware">
  <title>Stoneware</title>
  <defs>
    <!-- Glaze runs along the coil: mint where it catches, deep celadon in the
         turn. Angled so the gradient travels the length of the stroke. -->
    <linearGradient id="m-glaze" x1="12%" y1="4%" x2="88%" y2="96%">
      <stop offset="0" stop-color="#D9FFF0" />
      <stop offset="0.26" stop-color="#A8EACA" />
      <stop offset="0.62" stop-color="#5EDFCC" />
      <stop offset="1" stop-color="#1FA898" />
    </linearGradient>

    <filter id="m-bleed" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="2" />
    </filter>
  </defs>

  <!-- One continuous coil, two arcs. A letterform survives 16px in a way a
       ring never did, and it names the thing instead of decorating it. Round
       caps read as a rolled rope of clay rather than a cut stroke. -->
  <g fill="none" stroke-linecap="round">
    <!-- Bloom underneath, so the coil sits in its own light. -->
    <path d="M 45 19 A 12 12 0 1 0 32 32 A 12 12 0 1 1 19 45"
          stroke="#5EDFCC" stroke-width="11" filter="url(#m-bleed)" opacity="0.4" />
    <path d="M 45 19 A 12 12 0 1 0 32 32 A 12 12 0 1 1 19 45"
          stroke="url(#m-glaze)" stroke-width="10.5" />
  </g>
</svg>
`,

  "public/styles.css": () => `body {
  margin: 0;
  font: 16px/1.6 ui-sans-serif, system-ui, sans-serif;
  color: #16130f;
  background: #fbf9f6;
}

main {
  max-width: 40rem;
  margin: 0 auto;
  padding: 4rem 1.5rem;
}

button {
  font: inherit;
  padding: 0.5rem 1rem;
  border: 1px solid #ddd6cc;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}
`,

  // Where the site is published. Stated rather than derived from the request:
  // any host that terminates TLS for you forwards a plain HTTP request, so a
  // request-derived origin says http:// on a site served over https:// — and
  // that ends up in canonical links and the sitemap.
  "lib/site.ts": () => `/**
 * The public origin of this site.
 *
 * Set SITE_URL in the environment for anything that is not local development.
 * Absolute URLs — canonical links, og:image, the sitemap — are built from it.
 */
export const SITE_URL = Bun.env.SITE_URL ?? "http://localhost:3000";

/** Absolute URL for a path on this site. */
export function siteURL(path: string): string {
  return SITE_URL + path;
}
`,

  "routes/robots.txt.ts": () => `import type { ActionContext } from "stoneware";
import { siteURL } from "../lib/site.ts";

export function GET(_context: ActionContext): Response {
  const body = \`User-agent: *
Allow: /

Sitemap: \${siteURL("/sitemap.xml")}
\`;

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, no-cache" },
  });
}
`,

  "routes/sitemap.xml.ts": () => `import type { ActionContext } from "stoneware";
import { siteURL } from "../lib/site.ts";

/**
 * Add every page you publish here. Generating this list from the same data the
 * pages render is worth doing as soon as there is more than a handful — a
 * sitemap maintained by hand is a sitemap that goes stale.
 */
const PATHS = ["/"];

export function GET(_context: ActionContext): Response {
  const urls = PATHS.map((path) => \`  <url><loc>\${escapeXML(siteURL(path))}</loc></url>\`);

  const body = \`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
\${urls.join("\\n")}
</urlset>
\`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, no-cache",
    },
  });
}

/** XML, not HTML: apostrophes are legal in a URL and must be escaped here. */
function escapeXML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
`,

  "README.md": (name) => `# ${name}

Built with [stoneware](https://github.com/stoneware-dev/stoneware-core) - server-first, Bun-native.

    bun install
    bun run dev

## Layout

    routes/    Server-rendered pages and API routes. Never ships JavaScript.
    islands/   Interactive components. The only place client JS originates.
    lib/       Behavior functions and shared utilities.
    public/    Static assets, served as-is.

## Environment

Bun reads \`.env\` automatically - there is no dotenv dependency.

\`.env\` was generated with a unique \`STONEWARE_CSRF_SECRET\` and is gitignored. Set a
different one per environment; \`.env.example\` is the tracked template.
`,
};

/**
 * The favicon, base64-encoded.
 *
 * A .ico is binary, so it cannot be a template string like every other file
 * here. Embedded rather than copied from the package so this script keeps
 * working when run straight from a registry tarball by `npx`.
 */
const FAVICON_BASE64 =
  "AAABAAMAEBAAAAEAIAB6AgAANgAAACAgAAABACAARgYAALACAAAwMAAAAQAgAPcKAAD2CAAAiVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACQUlEQVR42oVTS2gTURSN/VBjKd100VVFxIV2Y62CoCL4gWxcRPy0JSqKUKM7hSoILoQUXQhuhCAVmyD2k0ZtShtDNbQ2xmneED+Z2NSKk2k6SUMbJ2KNNESPdyQDUZP44C7eve+cc39Pp8ufkyJfaNVdcqhh5JtsdGfi7bZ0tJV8erI12pt/TgG4hkDm8E9FmUUawo9lBLMJjK9Evd2LoSaKVxQlyTurSNUUQToXyi2Bz8bh/y5hYuUjPF9m4Ei9C9Kb2nIE+leriTBbleHLROFMRwZsy4JlKPVWdCzxeJAM4FacdapCpQhqpzIinn/9AMdngaN7PdnaGzIz9CwGcCfB0C0zq9qjkgSjioBHqde4nwxoBJWqn0iCFpllu2LMlPcVL6E3GQgTGFZSJJD92gJrOy/xjRSrI1unpV+yiaRiuh1nuZsyw/UFhqsxhkvzTDFLvFmdUOG4dSV2oOZyjJmvxJhycZ7hgsTjbJQH+XMdc9Omcg3U5YNqmnVnonwjWduJT8x+fNYPozCJQ2+84fxCFSWoJDXTOYnPnhZ5bd5qs+oJyB2cdmOvzwVtD4oRVJ8SeWvHHIcj7304OuMzqCNUCfb5R7mdXie2efrLElQdi7zsJDUYmAcHuDGRVC17poYHWp72oXnEjmaXvWwJv/dgPzcW3DXxGDueObDV/RBbXDZsct7D+n5rjjL4bxMrKIOm7eOD3s3Dvdg41KMCsWHwrtLi7vtjjOV+o/pl9bsnn7QSqJ1UjYeFFw3a+v5N8AtERvxXBuQoVQAAAABJRU5ErkJggolQTkcNChoKAAAADUlIRFIAAAAgAAAAIAgGAAAAc3p69AAABg1JREFUeNq9lwlMk2cYxz3wdtnwyDbNlHNOt+nUZWQYj23Z4ZyZk2wTUXa7e9nYlrngmDuMTnaYnYoKglY5RLkKAlMQ5er3gdwUEVooUAptBY9iS/XZ//14P1MbZ2hZ1uTJl/Rr+3ve////vk+/YcNu8QrViI41HDUCNRo1AeWJmoq6k189+fuj+eeGO37f5ddN4KNQt6HujuxuCMjp04cX2rriVP1GZZGtS5Hbp4/Y3tUQwO7zz41yu4mbwMegJjNwaX93mpp6rA3UQ3LVXTNTtb2bzvQb7HkWnXK7oW4R+zz/3giXm3CCM0mnJF5sXVt37bzZEVx71URVEriTRGsHlV7RUWFfC+Vfbu7dbawL5daMdlTC1QY8UHfE9GhW1FOPhUHV185L4Ep7F5XbOkmwtlMJA1u0dPJyM5241Ei5Fxooq7fOssNQGcSz4THoBpxWP+4DXYVv1VWzuh7gmqtGquxnYD2pAC7ua6XTEriJTlxspJwLagamjPPVlGqupERjecvbWtGP/c6gVXBoYCRqUqalfSPzt6LfQGUMfKWNigA+ZdFQ7sVz2pQedXZGT31TZk8tpQOcYqqgZGM5JXYLdLBLRb/qhQj2O/z3Bt2AnPppRdYOUfa3CP4WXNZQ3qVz9lhT3Wbc90fNQPn93lkelmQssyV0DYDjDCqKQf2lV1Xh/nTHLAy2gbEo7+I+nYX5WwB/87i/8eZaBe7NRE3kSWfXewCLigU0ulNFUZ0SnH7TC/Y3tFKjY11tYPw2Q02g7G+ug7+R+jPBfJt58M8yeW//uk1YuQvgPwfA9EuHQD+iPm0VljrmYNAN/NBZvVgKluyvecDfre3iGu6r3ICk2Fta0WdHh2D6GdBI1NZ2gb5rE0yva0UvrpTrFqSZq6wsWIeNZZTAg/WHXojm3k/gWfHgV89wnbBuS7tgApigiCmsVQhxaSs6h1DRXSbGA6rgwYo2SP7avm8XwnDfF3UXV2Mir8lYsfeHLeKS1zTSyj1dOoyctyG2UTgL1l4eLEd/t7ULNd+2CcmbdMKWjwBkDXMga2Q8l93DpZngfBDBVz9AmyE729MSOHIATlCBvoHUX6G+1Al2hE2Jg4c1MoVb6N5UdDqKPbHCoJ86BMt2OViozYBuGgDT560CwWuCCvR+i9j7plZ0fw78yzCa+oVOCIXcvQgWIWi0kYM/4eD3UFg9Yc/TqxrRsr5ZcH0O3OJPCJNzCla35DPIjLJ/3CoSgkbvojYAiuDRKxqR1jWpKLixhF5uKGpGE27PARnuwYM0ngeLrWgaJF4C6BZck5H0GrxHIQCvOVtML6kLKaj2FK2qzqcXagrC3ZkDjtJ7sq30DlYOWb356Sdvt0l8C/qubSwNe7G+0La6toCer8qnlRUn6NmyXFou5oh8Z4xy5RC6Hj5IHgKZTdxfdqKt4yo4Hj7sMJqxuqYg+rkzx2k5wE+pjtETJZn0WFGGNXSgcZfnwBis2Av+mjbwYHF/Tes1oo/DD8o2TcLq10jg4kxaVphOiwtSKTD/KFNjMbfQpQbGYbVLWbBkf4PPlkj+wueVbPBwX+UGJkP64KWnGTiFAvOOUMDxw/RwTgJBlUB3GmAr9A85V2pnwYK/xPxdBX9XVZ+MYqPXaRTPfLxYqXgU4Ef+TqKFAM/POkTzMhUWdy1gAZwOcBW8lYIl+/u0kG2DrGwO+PGB5A+/NwNsX5gdTw9lHaQHMw7QnLRYeiB9v9shHMl9jVjBwGIO3eDvqVTmcRMqG1JrFwA8L5OB99Oc1FiadTSG/A7voQXHDm0cyjYch9D5AdwCeWnZaTlY3N/cRAZgMrOV0uzUfXTvkWjyBdg7YRf5Ju1W4zDydekgutlWhPRBCJZF8vd4khSs+QDPVR6g+9Pj6L4UBt7LgOQF8Mz4nexqwXdWsL/0QzmKr8+BJ0uzQgHulfxl4DQGjiH/5L3kAzCDyoXVm6HQWj4Rh/RQMozPAemxDCfbIjSghL92v+Q95JMYdQPYK2GnFffSENIAh8ey/+zZ8PqD6TNiTsBcpSJidso+xayj0Up4H4cchHPw0B9M/+9H838A4Vls1diuCrUAAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAMAAAADAIBgAAAFcC+YcAAAq+SURBVHjazZoJWFTXFcddQAQUo9ioiHFBca+NaI3YRmMjTZPUtqZq0tZW01ZN0tja1jYmWNsYNdWEaqIxMW6oGFR2UFwQRASVN8M2g4IbDPviAAmIEsXT/31zHl7HQfPJo1/5vvPNKPOG37n3f/7n3DfTocM3/Pl1gaG16IjohOiM6IJwRbgjuiN6SOHB/+eGcEE48zUdORy+vy4/D4HXwAV0T0QfxADEYIQPYhhiKD8fiPBC9OaEXDmRTq0l0V7w2qo784oK8P4CdFddwazkpspNGbetqeY7NZbcO7XlInKaa/LSb12LOdJYFvh2mdkPrx2EeJwTcZF2Q98kHgAvVr0bQ/hENpQsym6uMedTHTmKC3dqKLfZSqbb1ZR5q7IpsbEkdFVF7hRc+wSiF++Gk65JtLL6GrzQc793ynP9jLevJTqCzkOcB7i5+RrlADzrViVlfF1OhqYySr9ZQmk3iur3111azvLqzbvpMAk9V9+Z4b0+rL44VcjkfvBaCbxKrDgZAa40ldI5gJ+5UUSpjYWUcr2Akq9foci6/GCuk968E511ScIBvBOvUp/3q/L87eEv3KltkUm2Cl4hgReLFafTAD91/SqdbLhCifWXKOGrfDr2VR6F1pi34n2HcD258E4/egKtSEe8sadwlqxmq+JI39mqTCrI8DVk0lRCZ1VwiwR+mU4A/DjAj355geLrztOhOjPF1ubQlsrMJXhvb97h+6Skx+qLNx5w7Eb5yvyH6PvsTcgE4CmNQiZXKUkFvyiB51JcrZlianIoyppFEdZMOlBtrPpTkUE41LcQXe13oS0JtKz+a0WZo03NVqum76yH6DupATIBuJDJEYAfVsFNd8GvZdDBaiPtr1boi6p0+rQifQs703278KgJaM1KaN8rpqF4mSN9n5H0ndRwpSm8Li9kXUXObFzz5BsW4+RPqrKXhtfkmKJrsikS4OEquIH2V9nA91am027Ejor0KlwznK21i7wLbUnAiRvO4JSbpcdt+i51qO+E+kuNm6vMC/HaEbySXtzkhvyu0DB+V5Ux4gDAQwG9j8GDETsR2yvSaSvi3RJlPl7flx1JlwSc2R18z9wssWrgjvS922peL17HDU6bfbQxYwCS8MNKF+xh8B2IbQwO+dDmcoXeL1U2cDG7y5balgTEVnquKMuZlNqogV9pAdf0fagut/F1i3ESr3o3aWBz4hoSSfj8p0xZq4F/hthSbgP/CLGhTE0gjuepbnokoBVw7w8qc2eo/n1PYZ5vKcyD1mwTXjfazkU62tfRP0uUuQL8E4BvYnAkRR8i1iPeK1ViOQF3XRNYV2EKSFBtMI/iv9T820S2wsykfdUZWVICLnYJtDjZ4kLD2I/LlfqNEvg628rTGsSKEmWjGFM44c5trYFOLRIqzfJXG0+trfFEAVz4d9g1I4nChJs0/LbQMMFOQp3spldRF96rS5WgDxh8LaDxb1pVohB2p3KxRe0Fvew7cltrQC3iqJqcOq3x2MBtNhiCEIUZVKasloq4m3R4ceJHV4YbtLJECYJc6t+1gVNgsWJ802IIYAdy17MPtNhoSHVGotp42L9D2L932TxcuEnD8mJlDnt5fx7QHpMcyZUTEyOJN1xpFKCnv24x+POB53G73eugVyMTK9IfbhG4T2o8mn9/zjYoChP6vgEtbxZguGYUT5oDWdee0hGzB+9sL3584ClNj1GiN1ZqHKCtcuORwEkrTEnfVmg7B4UZ8tcitUH5ssdrx0o3dqwuDzsn6zbMQedrBPgWbjwfs38HMfi/S+8WpqbvfyDeKVborWLFgoHtLT4r9+Vd6Mrv30m3A34r47T4Q55wmpFY6eyPJPD1Evh7EvgKBkdd0N8Q2AX6M2KJxZAK/U/l3ehhZ7vtcqTUdkHUQr+lRco0rLZ1veTfAvxfAF7J4G/bVlwF/wugcQ390WKgPyAgRUI/KH+10DCTk/BwVLhtOtS3sgvO/Me8ATUT0OWrJHBYYQv4sqK74Esk8EWFBvo9AjtJ8wsMVrzXNC5w9zYfZL7h7RQX3nbvNyyGqZBIaiDL5O8MLmQCravgeA29xuCQDb1qAydcT7+6kk6/uHwue95Vw0h2qK7tcZy0T8CJ/1APLsRhojCx2hYN/E0JfKEE/htAz7uq0C8B/sqls/Ry/hmak5eKSFvD84/ux8kOdgOZM1teV7ZAD7ZEoWNfrPJ8jAIheMyBTKxCJgsKJPDL51TwuflpNPtCKr10PoV+Zj5FPzWdtCKpcfxeLnoeJ+U5xpWB5eYjNyVP1vJAbl6iiU0H+GbI5MYrFzXw0/RSrgBPpp/knKQfZyXSC5knxPNA7t7u9rdW2trEnKW7cAMhCX+s8PQFNkBvBu/GCbqxDB7j1RRAw5HAHIA3qOAmAZ5kA89IoB8Zj9MPlaP0nOFYIt9T9dB7DhIr0hfSCIANGiV910MmQXyfs5c0BmiDm4uUuO/Pz59ePTM7iV7UwA3HVPAZ5+LpB2cP0/S0Q3XcqXuyTDvqMUoLiF7Qsh9ssFKAL5YKk/UdJN3PcTRCiyS8IKUJAG/ASlNAOoOfOUTPpMbR1NMx9P1T0TQr95Q/76guB3rtFNUPTWfjYsm/F2g2aCvMesCN5T/c2kFGHHJGAz7r2bPxNB3g0wD+dIoAj6IpJyNpclI4vZh5IsBRIT9KAvIUKg7jsQ78m16+KGwwjVCgc/kg42Y3kGkjiJoA4E3TUmNV8O8lR5E/wJ9KDKdJJw7SxOMH6PmMhBl6JyC2fwBkEjdPAxf+fdHm39C12HbxuJbvMmv3Np0k21UlhOsmAbxRBU+KUMG/m3CQJgB8/NFQejJ+H+w0eZIkoY567YA3wDfY/FsDT6FZNv8mUZhwlALIyY+bUU++TnMktYix+usnC/ATYTbwY/tV8O8A/NuHQhB7rVIRO+tVxMJZ+mL15suNR/j3zOxEoVl6HjYoChOPEUh0PN9l7s+SEje3RuD3C59KDGsUMvET4Ee+YPC9NCZ2D42KCRbPj+tto9qBXljkcIBXyY1H+PdzsMGA9CP0rLBBFCbChESWYrcmi9uKsMzZT6dEhwC8yU/IBODjDofQWICPjt1No6KDaUTUTvKN2CFqYJmDOtKlDwgZPAG5bJEbz4xzR9i/42jaaVGY0VyY9+pbBY9n8Lg9KvjI6F00PHInDYvYTkPDtpFP2OdW1NVoOyfT7TipughW1Q/gVTb/PkzPpAn/jlX9e0pyJBemY32PEeAxGvgOGha+XUDT4ANbaWDopyK5le01zMm74P1CZsISufHY/DsCNhhGEzVwB/oeEbVLlYkKfvAuuAjsgMJHTM/2/nRGuMMQ6HyrCq76dxhphWnT9z5V32Ps9C1kMgTgg/Z/1gIuYsiBrRYUuD9/vuymy4HmAR9ou3KTGYrVD56o6VsrzLi9rO9gVd++rG9A3geuwcMApnLhdre3zvb4hFL7kE8k4YMklgO8fuw9+t7J+t6mymSQHbQWeE0iHM2Px+/u9rNPex4pnaTbg0/AUqdA76EAb3Kkb/vA783YuUXctbW7cF1auyPRXl8z6Mw14cEQgzAC+CGRQDhMDCDzkES5CCETJJYKaW2Cxc7ig05/rie3/4fvSrhKx0ovPo35MOgwfj6YLbKPNGZ0edD3I/5X31SRz8ku0uzjYfdVm+4M7SqB63IX7r+FhcSElZtvSgAAAABJRU5ErkJggg==";

function directoryExists(path) {
  return existsSync(path) && statSync(path).isDirectory();
}

/** True when this process is Bun rather than Node. */
const isBun = typeof globalThis.Bun !== "undefined";

function main() {
  const target = process.argv[2];

  if (!target || target.startsWith("-")) {
    console.log("Usage: bunx create-stoneware <directory>   (npx also works)");
    process.exit(target ? 0 : 1);
  }

  const dir = resolve(target);
  const name = basename(dir);

  if (directoryExists(dir) && readdirSync(dir).length > 0) {
    console.error(`[stoneware] ${dir} already exists and is not empty.`);
    process.exit(1);
  }

  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(dir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents(name));
  }

  // Binary, so it cannot go through the template map above.
  const favicon = join(dir, "public", "favicon.ico");
  mkdirSync(dirname(favicon), { recursive: true });
  writeFileSync(favicon, Buffer.from(FAVICON_BASE64, "base64"));

  console.log(`Created ${name} in ${dir}\n`);
  console.log("Next:");
  console.log(`  cd ${target}`);
  console.log("  bun install");
  console.log("  bun run dev");

  if (!isBun) {
    console.log(
      "\nNote: the project was scaffolded with Node, but Stoneware itself runs on Bun.\n" +
        "If you do not have it yet: https://bun.sh/docs/installation",
    );
  }
}

main();
