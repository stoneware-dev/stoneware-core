#!/usr/bin/env bun
/**
 * The `sinter` CLI (CLAUDE.md §13).
 */

import { resolve } from "node:path";
import { build, describeBuild } from "./build.ts";
import { dev } from "./dev.ts";

const USAGE = `sinter - a Bun-native, server-first web framework

Usage
  sinter dev     [--root <dir>] [--port <n>]   Start the dev server with hot reload
  sinter build   [--root <dir>]                Production build (server + island bundles)
  sinter start   [--root <dir>] [--port <n>]   Run the production server bundle

Options
  --root <dir>   Project directory (default: current directory)
  --port <n>     Port to listen on (default: 3000, or $PORT)
  -h, --help     Show this message
`;

interface Args {
  command: string | undefined;
  root: string;
  port: string | undefined;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: undefined, root: process.cwd(), port: undefined, help: false };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--root") args.root = resolve(argv[++index] ?? ".");
    else if (arg === "--port") args.port = argv[++index];
    else if (!arg.startsWith("-") && args.command === undefined) args.command = arg;
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  if (args.help || args.command === undefined) {
    console.log(USAGE);
    process.exit(args.command === undefined && !args.help ? 1 : 0);
  }

  // The CLI flag wins over sinter.config.ts, which wins over the default.
  if (args.port) process.env.PORT = args.port;

  switch (args.command) {
    case "dev":
      await dev(args.root);
      break;

    case "build": {
      const started = performance.now();
      const result = await build(args.root);
      const elapsed = Math.round(performance.now() - started);
      console.log(`[sinter] build complete in ${elapsed}ms`);
      console.log(describeBuild(result, args.root));
      break;
    }

    case "start": {
      const bundle = resolve(args.root, ".sinter", "server.js");
      if (!(await Bun.file(bundle).exists())) {
        console.error(`[sinter] No production build found at ${bundle}. Run \`sinter build\` first.`);
        process.exit(1);
      }
      await import(Bun.pathToFileURL(bundle).href);
      break;
    }

    default:
      console.error(`[sinter] Unknown command: ${args.command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

await main();
