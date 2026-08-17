#!/usr/bin/env bun
/**
 * The `stoneware` CLI (CLAUDE.md §13).
 */

import { join, relative, resolve } from "node:path";
import { build, describeBuild } from "./build.ts";
import { dev } from "./dev.ts";
import { exportSite } from "./export.ts";
import { describeDoctor, doctor } from "./doctor.ts";
import { describePreview, preview } from "./preview.ts";
import { describeRoutes, listRoutes } from "./routes.ts";
import { emitVercel } from "./vercel.ts";

const USAGE = `stoneware - a Bun-native, server-first web framework

Usage
  stoneware dev     [--root <dir>] [--port <n>]   Start the dev server with hot reload
  stoneware build   [--root <dir>] [--target <t>] Production build (server + island bundles)
  stoneware start   [--root <dir>] [--port <n>]   Run the production server bundle
  stoneware export  [--root <dir>] [--out <dir>]   Prerender to static HTML
  stoneware preview [--root <dir>] [--out <dir>]   Serve a static export as a host would
  stoneware routes  [--root <dir>]                Print the route table, in match order
  stoneware doctor  [--root <dir>]                Check the project setup

Options
  --root <dir>     Project directory (default: current directory)
  --port <n>       Port to listen on (default: 3000, or $PORT)
  --target <t>     Deployment target for \`build\`: node (default) or vercel
  -h, --help       Show this message
      --open       Open a browser when the dev server starts
  -v, --version    Print the Stoneware and Bun versions
`;

const TARGETS = ["default", "vercel"] as const;
type Target = (typeof TARGETS)[number];

interface Args {
  command: string | undefined;
  root: string;
  port: string | undefined;
  out: string | undefined;
  target: string | undefined;
  help: boolean;
  version: boolean;
  open: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: undefined,
    root: process.cwd(),
    port: undefined,
    out: undefined,
    target: undefined,
    help: false,
    version: false,
    open: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "-v" || arg === "--version") args.version = true;
    else if (arg === "--open") args.open = true;
    else if (arg === "--root") args.root = resolve(argv[++index] ?? ".");
    else if (arg === "--port") args.port = argv[++index];
    else if (arg === "--out") args.out = argv[++index];
    else if (arg === "--target") args.target = argv[++index];
    else if (!arg.startsWith("-") && args.command === undefined) args.command = arg;
  }

  return args;
}

/**
 * Both versions on one line.
 *
 * Bun's is included because it is half of any useful bug report: the framework
 * is built on Bun's own primitives, and one of them has already shipped a
 * request-triggerable panic. "Which Bun?" is the first question either way, so
 * asking once is cheaper than asking twice.
 */
async function versionLine(): Promise<string> {
  const manifest = join(import.meta.dir, "..", "..", "package.json");
  const { version } = (await Bun.file(manifest).json()) as { version: string };
  return `stoneware ${version} (bun ${Bun.version})`;
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2));

  if (args.version) {
    console.log(await versionLine());
    process.exit(0);
  }

  if (args.help || args.command === undefined) {
    console.log(USAGE);
    process.exit(args.command === undefined && !args.help ? 1 : 0);
  }

  // The CLI flag wins over stoneware.config.ts, which wins over the default.
  if (args.port) process.env.PORT = args.port;

  switch (args.command) {
    case "dev":
      await dev(args.root, { open: args.open });
      break;

    case "export": {
      const started = performance.now();
      const result = await exportSite(args.root, args.out ?? "dist");
      const elapsed = Math.round(performance.now() - started);
      console.log(`[stoneware] exported ${result.pages} page(s) in ${elapsed}ms`);
      console.log(`  output   ${result.outDir}`);
      for (const skip of result.skipped) console.log(`  skipped  ${skip}`);

      if (result.csp === false) {
        console.log(`  csp      disabled in config, so none was embedded`);
      } else {
        console.log(`  csp      embedded in every page, and written to _headers`);
        if (result.headerOnly.length > 0) {
          // Naming them beats implying the export is protected identically to
          // the server. On Netlify and Cloudflare Pages _headers restores them;
          // anywhere else they are genuinely absent.
          console.log(
            `           ${result.headerOnly.join("; ")} needs a real header —\n` +
              `           _headers covers Netlify and Cloudflare Pages, other hosts need config`,
          );
        }
      }
      break;
    }

    case "build": {
      const target = (args.target ?? "default") as Target;
      if (!TARGETS.includes(target)) {
        console.error(
          `[stoneware] Unknown target: ${args.target}. Expected one of ${TARGETS.join(", ")}.`,
        );
        process.exit(1);
      }

      const started = performance.now();
      const result = await build(args.root);
      const elapsed = Math.round(performance.now() - started);
      console.log(`[stoneware] build complete in ${elapsed}ms`);
      console.log(describeBuild(result, args.root));

      if (target === "vercel") {
        const vercel = await emitVercel(args.root);
        console.log(`  target   vercel`);
        console.log(`  entry    ${relative(args.root, vercel.entrypoint).replace(/\\/g, "/")}`);
        if (vercel.wroteConfig) console.log(`  config   vercel.json`);
        // Named because it writes into the project's own public/ directory,
        // and because the deploy is broken without it in a way that looks like
        // a CSS bug rather than a missing file.
        console.log(`  assets   ${vercel.copiedAssets} file(s) copied to public/_stoneware/`);
        if (vercel.configNote) console.warn(`[stoneware] ${vercel.configNote}`);
      }
      break;
    }

    case "preview": {
      const result = await preview(args.root, args.out ?? "dist");
      console.log(`[stoneware] preview`);
      console.log(describePreview(result, args.root));
      break;
    }

    case "routes": {
      const result = await listRoutes(args.root);
      console.log(describeRoutes(result));
      break;
    }

    case "doctor": {
      const result = await doctor(args.root);
      console.log(describeDoctor(result));
      // Exit non-zero on an error so this is usable in CI, but not on a warning:
      // a warning is a judgement call, and failing a pipeline over one would
      // teach people to stop running it.
      if (result.errors > 0) process.exit(1);
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
