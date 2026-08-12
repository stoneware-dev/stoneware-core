/**
 * `sinter dev` - one process serving HTML, client chunks, and live reload
 * (CLAUDE.md §12).
 *
 * There is no second dev-server process and no proxy: `Bun.serve()` handles the
 * pages, the built island chunks, and the reload socket on one port.
 */

import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { join } from "node:path";
import { CLIENT_ASSET_PREFIX } from "../build.ts";
import { loadConfigFile } from "../config.ts";
import { directoryExists } from "../router.ts";
import { createApp } from "../server.ts";
import type { FSWatcher } from "node:fs";
import type { ServerWebSocket } from "bun";

const LIVE_RELOAD_PATH = `${CLIENT_ASSET_PREFIX}/live-reload`;
const LIVE_RELOAD_SCRIPT = `${CLIENT_ASSET_PREFIX}/live-reload.js`;

/** Coalesce editor write bursts into a single rebuild. */
const DEBOUNCE_MS = 60;

/** Set on the child process so it does not re-exec itself forever. */
const HOT_SENTINEL = "SINTER_HOT";

/**
 * State that must survive `--hot` re-evaluation.
 *
 * Under `bun --hot` this module is re-evaluated whenever a file it imports
 * changes, which is exactly what makes route edits take effect. Anything held in
 * a module-level binding is therefore recreated each time, so watchers and open
 * sockets are parked on globalThis and cleaned up on the way back in.
 */
interface DevState {
  sockets: Set<ServerWebSocket<unknown>>;
  watchers: FSWatcher[];
  started: boolean;
}

const state: DevState = ((globalThis as Record<string, unknown>).__sinterDev ??= {
  sockets: new Set(),
  watchers: [],
  started: false,
}) as DevState;

/**
 * Re-run the CLI under `bun --hot`.
 *
 * Without it, edits to a route never reach the browser. Bun resolves a `file:`
 * import to the same module regardless of a `?v=` query, so the usual
 * cache-busting trick silently does nothing — the watcher fires, islands
 * rebuild, and the page keeps serving the previous template. `--hot` is the
 * supported way to invalidate a module (CLAUDE.md §12).
 */
function reexecUnderHot(): never {
  const entry = join(import.meta.dir, "index.ts");
  const result = spawnSync(process.execPath, ["--hot", entry, ...Bun.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [HOT_SENTINEL]: "1" },
  });
  process.exit(result.status ?? 0);
}

export async function dev(root: string): Promise<void> {
  if (!process.env[HOT_SENTINEL]) reexecUnderHot();

  // A re-evaluation means something the server imports actually changed.
  const isReload = state.started;
  state.started = true;

  // Watchers are recreated below; drop the previous generation first.
  for (const watcher of state.watchers) watcher.close();
  state.watchers = [];

  const userConfig = await loadConfigFile(root);
  const app = await createApp(
    { ...userConfig, root },
    {
      dev: true,
      documentSuffix: `<script type="module" src="${LIVE_RELOAD_SCRIPT}"></script>`,
    },
  );

  const clientScript = await buildLiveReloadClient();
  // Connections outlive a hot re-evaluation, so the browsers already attached
  // are the ones that need telling about it.
  const sockets = state.sockets;

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
        console.log(`[sinter] rebuilt (${reason})`);
      } catch (error) {
        console.error("[sinter] rebuild failed:", error);
      }
    }, DEBOUNCE_MS);
  }

  // public/ is watched too: editing a stylesheet is as much an edit as editing
  // a template, and without it CSS changes appear only on a manual refresh.
  const watched = [
    app.config.routesDir,
    app.config.islandsDir,
    app.config.publicDir,
    join(app.config.root, "lib"),
  ];
  state.watchers = watched.filter(directoryExists).map((dir) =>
    watch(dir, { recursive: true }, (_event, filename) => {
      scheduleReload(filename ? String(filename) : dir);
    }),
  );

  // Server modules were just re-evaluated with the new code, so the browser is
  // now the only stale copy.
  if (isReload) {
    for (const socket of sockets) socket.send("reload");
  }

  const shutdown = () => {
    for (const watcher of state.watchers) watcher.close();
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (isReload) {
    console.log("[sinter] server modules reloaded");
    return;
  }

  const count = state.watchers.length;
  console.log(`[sinter] dev server on http://${app.config.hostname}:${server.port}`);
  console.log(`[sinter] watching ${count} director${count === 1 ? "y" : "ies"}`);
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
