#!/usr/bin/env bun
/**
 * The `stoneware` CLI (CLAUDE.md §13).
 */

import { resolve } from "node:path";
import { build, describeBuild } from "./build.ts";
import { dev } from "./dev.ts";
import { exportSite } from "./export.ts";

const USAGE = `stoneware - a Bun-native, server-first web framework

Usage
  stoneware dev     [--root <dir>] [--port <n>]   Start the dev server with hot reload
  stoneware build   [--root <dir>]                Production build (server + island bundles)
  stoneware start   [--root <dir>] [--port <n>]   Run the production server bundle
  stoneware export  [--root <dir>] [--out <dir>]   Prerender to static HTML

Options
  --root <dir>   Project directory (default: current directory)
  --port <n>     Port to listen on (default: 3000, or $PORT)
  -h, --help     Show this message
`;

interface Args {
  command: string | undefined;
  root: string;
  port: string | undefined;
  out: string | undefined;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: undefined,
    root: process.cwd(),
    port: undefined,
    out: undefined,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--root") args.root = resolve(argv[++index] ?? ".");
    else if (arg === "--port") args.port = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
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

  // The CLI flag wins over stoneware.config.ts, which wins over the default.
  if (args.port) process.env.PORT = args.port;

  switch (args.command) {
    case "dev":
      await dev(args.root);
      break;

    case "export": {
      const started = performance.now();
      const result = await exportSite(args.root, args.out ?? "dist");
      const elapsed = Math.round(performance.now() - started);
      console.log(`[stoneware] exported ${result.pages} page(s) in ${elapsed}ms`);
      console.log(`  output   ${result.outDir}`);
      for (const skip of result.skipped) console.log(`  skipped  ${skip}`);
      break;
    }

    case "build": {
      const started = performance.now();
      const result = await build(args.root);
      const elapsed = Math.round(performance.now() - started);
      console.log(`[stoneware] build complete in ${elapsed}ms`);
      console.log(describeBuild(result, args.root));
      break;
    }

    case "start": {
      const bundle = resolve(args.root, ".stoneware", "server.js");
      if (!(await Bun.file(bundle).exists())) {
        console.error(`[stoneware] No production build found at ${bundle}. Run \`stoneware build\` first.`);
        process.exit(1);
      }
      await import(Bun.pathToFileURL(bundle).href);
      break;
    }

    default:
      console.error(`[stoneware] Unknown command: ${args.command}\n`);
      console.log(USAGE);
      process.exit(1);
  }
}

await main();
