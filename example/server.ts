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

import { createApp } from "stoneware";
import config from "./stoneware.config.ts";

// dev: false makes the app read the island manifest that `stoneware build`
// already wrote, instead of rebuilding chunks (and changing their hashed
// filenames) on every cold start.
const app = await createApp(config, { dev: false });

Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  fetch: (request) => app.fetch(request),
});
