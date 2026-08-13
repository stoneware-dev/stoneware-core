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
        dependencies: { stoneware: "^0.1.2" },
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

  "lib/.gitkeep": () => "",

  "README.md": (name) => `# ${name}

Built with [stoneware](https://github.com/RANJEETJ06/Stoneware) - server-first, Bun-native.

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
