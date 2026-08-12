/**
 * `kiln dev` - one process serving HTML, client chunks, and live reload
 * (CLAUDE.md §12).
 *
 * There is no second dev-server process and no proxy: `Bun.serve()` handles the
 * pages, the built island chunks, and the reload socket on one port.
 */

import { watch } from "node:fs";
import { join } from "node:path";
import { CLIENT_ASSET_PREFIX } from "../build.ts";
import { loadConfigFile } from "../config.ts";
import { directoryExists } from "../router.ts";
import { createApp } from "../server.ts";
import type { ServerWebSocket } from "bun";

const LIVE_RELOAD_PATH = `${CLIENT_ASSET_PREFIX}/live-reload`;
const LIVE_RELOAD_SCRIPT = `${CLIENT_ASSET_PREFIX}/live-reload.js`;

/** Coalesce editor write bursts into a single rebuild. */
const DEBOUNCE_MS = 60;

export async function dev(root: string): Promise<void> {
  const userConfig = await loadConfigFile(root);
  const app = await createApp(
    { ...userConfig, root },
    {
      dev: true,
      documentSuffix: `<script type="module" src="${LIVE_RELOAD_SCRIPT}"></script>`,
    },
  );

  const clientScript = await buildLiveReloadClient();
  const sockets = new Set<ServerWebSocket<unknown>>();

  const server = Bun.serve({
    port: app.config.port,
    hostname: app.config.hostname,

    async fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === LIVE_RELOAD_PATH) {
        if (server.upgrade(request)) return undefined;
        return new Response("Expected a WebSocket upgrade", { status: 426 });
      }

      if (url.pathname === LIVE_RELOAD_SCRIPT) {
        return new Response(clientScript, {
          headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" },
        });
      }

      return app.fetch(request);
    },

    websocket: {
      open(socket) {
        sockets.add(socket);
      },
      close(socket) {
        sockets.delete(socket);
      },
      message() {
        // The reload channel is server-to-client only.
      },
    },
  });

  let pending: ReturnType<typeof setTimeout> | null = null;

  function scheduleReload(reason: string): void {
    if (pending) clearTimeout(pending);
    pending = setTimeout(async () => {
      pending = null;
      try {
        await app.refresh();
        for (const socket of sockets) socket.send("reload");
        console.log(`[kiln] rebuilt (${reason})`);
      } catch (error) {
        console.error("[kiln] rebuild failed:", error);
      }
    }, DEBOUNCE_MS);
  }

  const watched = [app.config.routesDir, app.config.islandsDir, join(app.config.root, "lib")];
  const watchers = watched.filter(directoryExists).map((dir) =>
    watch(dir, { recursive: true }, (_event, filename) => {
      scheduleReload(filename ? String(filename) : dir);
    }),
  );

  const shutdown = () => {
    for (const watcher of watchers) watcher.close();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`[kiln] dev server on http://${app.config.hostname}:${server.port}`);
  console.log(`[kiln] watching ${watchers.length} director${watchers.length === 1 ? "y" : "ies"}`);
}

/**
 * The reload client is TypeScript in this package, so it is bundled for the
 * browser once at startup and kept in memory.
 */
async function buildLiveReloadClient(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "live-reload.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });

  if (!result.success) {
    throw new Error(`Failed to build the live-reload client:\n${result.logs.join("\n")}`);
  }
  return await result.outputs[0]!.text();
}
