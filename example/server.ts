/**
 * Deployment entry point for the documentation site.
 *
 * Vercel's Bun framework preset looks for a `server.{ts,js}` in the project root
 * and detects the single `Bun.serve()` call made at module startup, then routes
 * requests through it. `port` and `hostname` are ignored there and only matter
 * when running this file locally.
 *
 * Nothing here is Vercel-specific: any host that can run `bun server.ts` — Fly,
 * Railway, Render, a container, a VPS — runs the same file unchanged.
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "stoneware";
import config from "./stoneware.config.ts";

/**
 * Stoneware resolves routes from the filesystem at runtime, so `routes/` has to
 * exist in the deployed bundle — not just at build time. Serverless platforms
 * bundle only what they can trace through imports, and a directory that is
 * merely *scanned* is invisible to that tracing; on Vercel it is `includeFiles`
 * in vercel.json that carries it across.
 *
 * When that is misconfigured the failure is a bare FUNCTION_INVOCATION_FAILED
 * with no hint. This preflight turns it into a log line that names the missing
 * directory and shows what the function can actually see.
 */
function preflight(): void {
  const cwd = process.cwd();
  const required = ["routes"];
  const missing = required.filter((dir) => !existsSync(resolve(cwd, dir)));

  if (missing.length === 0) return;

  let visible: string[] = [];
  try {
    visible = readdirSync(cwd);
  } catch {
    visible = ["<unreadable>"];
  }

  console.error(
    [
      `[stoneware] Cannot start: missing ${missing.join(", ")} in ${cwd}`,
      ``,
      `The deployed bundle does not contain the directories Stoneware reads at`,
      `runtime. On Vercel, add them to vercel.json:`,
      ``,
      `  "functions": { "server.ts": { "includeFiles": "{routes,public,.stoneware}/**" } }`,
      ``,
      `If the key "server.ts" does not match this function's path, includeFiles is`,
      `silently ignored — check the path shown in the Vercel build log.`,
      ``,
      `Present in ${cwd}: ${visible.join(", ") || "(empty)"}`,
    ].join("\n"),
  );
}

preflight();

// dev: false makes the app read the island manifest that `stoneware build`
// already wrote, instead of rebuilding chunks (and changing their hashed
// filenames) on every cold start.
const app = await createApp(config, { dev: false });

Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  fetch: (request) => app.fetch(request),
});
