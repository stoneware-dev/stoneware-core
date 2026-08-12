#!/usr/bin/env bun
/**
 * `bunx create-kiln my-site` - scaffold a new project (CLAUDE.md §13).
 *
 * The generated tree is the §5 convention with nothing extra: routes/, islands/,
 * lib/, public/, and a config file. It runs as-is, and every file in it is
 * meant to be read.
 */

import { mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { directoryExists } from "../router.ts";

const files: Record<string, (name: string) => string> = {
  "package.json": (name) =>
    JSON.stringify(
      {
        name,
        private: true,
        type: "module",
        scripts: { dev: "kiln dev", build: "kiln build", start: "kiln start" },
        dependencies: { kiln: "^0.1.0" },
        devDependencies: { "@types/bun": "^1.3.0" },
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
          jsxImportSource: "kiln",
          strict: true,
          skipLibCheck: true,
          types: ["bun"],
        },
      },
      null,
      2,
    ) + "\n",

  "kiln.config.ts": () => `import { defineConfig } from "kiln";

export default defineConfig({
  port: 3000,
  // The framework's default Content-Security-Policy applies unless you replace
  // it here. The CSRF secret comes from KILN_CSRF_SECRET in .env - keep it out
  // of this file so it is never committed.
});
`,

  ".gitignore": () =>
    [
      "node_modules/",
      ".kiln/",
      "",
      "# Secrets. Bun loads these automatically; .env.example is the tracked template.",
      ".env",
      ".env.*",
      "!.env.example",
      "",
    ].join("\n"),

  // Generated with a real secret so `bun run dev` starts clean, and so nobody
  // is tempted to paste a placeholder into production. Bun reads .env natively,
  // so there is no dotenv dependency.
  ".env": () => `KILN_CSRF_SECRET=${crypto.randomUUID()}${crypto.randomUUID()}\n`,

  ".env.example": () => `# Copy to .env and set a unique value per environment.
# Signs CSRF tokens: rotating it invalidates every form currently rendered.
KILN_CSRF_SECRET=
`,

  "routes/index.tsx": () => `import type { PageProps } from "kiln";
import Counter from "../islands/Counter.tsx";

export default function Home(_props: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Welcome to kiln</title>
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

  "islands/Counter.tsx": () => `import { signal } from "kiln/signals";

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

Built with [kiln](https://github.com/kiln/kiln) - server-first, Bun-native.

    bun install
    bun run dev

## Layout

    routes/    Server-rendered pages and API routes. Never ships JavaScript.
    islands/   Interactive components. The only place client JS originates.
    lib/       Behavior functions and shared utilities.
    public/    Static assets, served as-is.

## Environment

Bun reads \`.env\` automatically - there is no dotenv dependency.

\`.env\` was generated with a unique \`KILN_CSRF_SECRET\` and is gitignored. Set a
different one per environment; \`.env.example\` is the tracked template.
`,
};

async function main(): Promise<void> {
  const target = Bun.argv[2];

  if (!target || target.startsWith("-")) {
    console.log("Usage: bunx create-kiln <directory>");
    process.exit(target ? 0 : 1);
  }

  const dir = resolve(target);
  const name = basename(dir);

  if (directoryExists(dir)) {
    const glob = new Bun.Glob("*");
    for await (const _entry of glob.scan({ cwd: dir, onlyFiles: false })) {
      console.error(`[kiln] ${dir} already exists and is not empty.`);
      process.exit(1);
    }
  }

  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(dir, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, contents(name));
  }

  console.log(`Created ${name} in ${dir}\n`);
  console.log("Next:");
  console.log(`  cd ${target}`);
  console.log("  bun install");
  console.log("  bun run dev");
}

await main();
