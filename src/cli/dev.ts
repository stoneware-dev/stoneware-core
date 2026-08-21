/**
 * `stoneware dev` - one process serving HTML, client chunks, and live reload
 * (CLAUDE.md §12).
 *
 * There is no second dev-server process and no proxy: `Bun.serve()` handles the
 * pages, the built island chunks, and the reload socket on one port.
 */

import { spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { join, relative } from "node:path";
import { CLIENT_ASSET_PREFIX } from "../build/build.ts";
import { loadConfigFile } from "../config.ts";
import { consoleObserver } from "../http/observe.ts";
import { directoryExists } from "../routing/router.ts";
import { createApp } from "../http/server.ts";
import type { RefreshOptions } from "../http/server.ts";
import { listen } from "../http/listen.ts";

/** A stylesheet is the one thing under `routes/` that is built rather than imported. */
function isCSS(file: string): boolean {
  return file.endsWith(".css");
}
import type { FSWatcher } from "node:fs";
import type { ServerWebSocket } from "bun";

const LIVE_RELOAD_PATH = `${CLIENT_ASSET_PREFIX}/live-reload`;
const LIVE_RELOAD_SCRIPT = `${CLIENT_ASSET_PREFIX}/live-reload.js`;

/** Coalesce editor write bursts into a single rebuild. */
const DEBOUNCE_MS = 60;

/** Set on the child process so it does not re-exec itself forever. */
const HOT_SENTINEL = "STONEWARE_HOT";

/**
 * State that must survive `--hot` re-evaluation.
 *
 * Under `bun --hot` this module is re-evaluated whenever a file it imports
 * changes, which is exactly what makes route edits take effect. Anything held in
 * a module-level binding is therefore recreated each time, so watchers and open
 * sockets are parked on globalThis and cleaned up on the way back in.
 */
interface DevState {
  sockets: Set<ServerWebSocket<undefined>>;
  watchers: FSWatcher[];
  started: boolean;
  /**
   * The one server, kept so a re-evaluation can hand it a new handler instead
   * of binding a second port.
   */
  server: Bun.Server<undefined> | null;
  /** Signal handlers are registered on the process, which survives everything. */
  signalsBound: boolean;
}

const state: DevState = ((globalThis as Record<string, unknown>).__stonewareDev ??= {
  sockets: new Set(),
  watchers: [],
  started: false,
  server: null,
  signalsBound: false,
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

/**
 * Turn a rebuild failure into something worth reading.
 *
 * `Bun.build` rejects with an `AggregateError` whose own message is the useless
 * string "Bundle failed" - everything that identifies the problem is on the
 * `BuildMessage`s inside it, including a `position` with the file, line, column
 * and source text. Sending the top-level message alone would tell a developer
 * only that something, somewhere, did not compile.
 */
function formatBuildFailure(error: unknown, root: string): string {
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    return error.errors.map((item) => formatBuildMessage(item, root)).join("\n\n");
  }
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

interface BuildPosition {
  file?: string;
  line?: number;
  column?: number;
  lineText?: string;
}

function formatBuildMessage(item: unknown, root: string): string {
  // A `BuildMessage` is not an `instanceof Error`, so `String(it)` prefixes the
  // class name onto the text - "BuildMessage: Expected ")"". Reading `.message`
  // gets the sentence a compiler would have printed.
  const named = item as { message?: unknown; position?: BuildPosition } | null;
  const message = typeof named?.message === "string" ? named.message : String(item);
  const position = named?.position;

  if (!position?.file) return message;

  // Relative to the project, because an absolute path is mostly noise and the
  // useful part - which file of yours broke - is at the end of it.
  const file = relative(root, position.file).replace(/\\/g, "/") || position.file;
  const where = `${file}:${position.line ?? 0}:${position.column ?? 0}`;

  let out = `${where}\n  ${message}`;
  if (position.lineText) {
    // A caret under the offending column, the way a compiler would.
    const caret = " ".repeat(Math.max(0, position.column ?? 0));
    out += `\n\n  ${position.lineText}\n  ${caret}^`;
  }
  return out;
}

/**
 * Is this upgrade coming from a page the dev server itself served?
 *
 * A missing `Origin` is allowed: non-browser clients (a test, a CLI) omit it,
 * and they are not the threat here - the attack needs a browser to carry it,
 * and every browser sends the header on a WebSocket handshake.
 */
function isSameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;

  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

export interface DevOptions {
  /** Open a browser at the served URL. Only on a first start, never a reload. */
  open?: boolean;
}

export async function dev(root: string, options: DevOptions = {}): Promise<void> {
  if (!process.env[HOT_SENTINEL]) reexecUnderHot();

  // A re-evaluation means something the server imports actually changed.
  const isReload = state.started;
  state.started = true;

  // Watchers are recreated below; drop the previous generation first.
  for (const watcher of state.watchers) watcher.close();
  state.watchers = [];

  const userConfig = await loadConfigFile(root);
  const app = await createApp(
    {
      ...userConfig,
      root,
      // A dev server that says nothing while you reload a page you are actively
      // editing is the wrong default - which route answered, and whether it was
      // a 200, is the first thing you look for. Production stays silent unless
      // the project asks, and a project that configured its own observer keeps
      // it here too.
      observe: userConfig.observe ?? consoleObserver(),
    },
    {
      dev: true,
      documentSuffix: `<script type="module" src="${LIVE_RELOAD_SCRIPT}"></script>`,
    },
  );

  const clientScript = await buildLiveReloadClient();
  // Connections outlive a hot re-evaluation, so the browsers already attached
  // are the ones that need telling about it.
  const sockets = state.sockets;

  const handlers = {
    async fetch(request: Request, server: Bun.Server<undefined>) {
      const url = new URL(request.url);

      if (url.pathname === LIVE_RELOAD_PATH) {
        // WebSockets are exempt from the same-origin policy, so without this
        // check any page you visit while the dev server runs can connect to it
        // and read what it broadcasts - which now includes build errors
        // carrying your file paths and source lines.
        if (!isSameOrigin(request, url)) {
          return new Response("Forbidden", { status: 403 });
        }
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
      open(socket: ServerWebSocket<undefined>) {
        sockets.add(socket);
      },
      close(socket: ServerWebSocket<undefined>) {
        sockets.delete(socket);
      },
      message() {
        // The reload channel is server-to-client only.
      },
    },
  };

  /**
   * One server for the life of the process, handed a new handler on each
   * re-evaluation.
   *
   * Binding again instead was the cause of a whole family of dev-only failures.
   * `bun --hot` re-evaluates this module when anything it imports changes -
   * which an edit under `islands/` does, because island modules are imported
   * through the framework's own graph. A second `Bun.serve` then started on the
   * next free port while the first stayed bound, so the browser kept talking to
   * a server built from the *previous* module graph. Values crossing between the
   * two failed every identity check the renderer makes, and pages 500'd with
   * errors that pointed at the template rather than at the reload. Each edit
   * added another stranded server.
   *
   * `reload()` swaps the handler in place: same port, same open sockets, one
   * live module graph.
   */
  if (state.server) {
    state.server.reload(handlers as never);
  } else {
    state.server = await listen<undefined>({
      // A busy port in development is nearly always a previous run that has not
      // exited. Walking to the next one beats refusing to start.
      allowPortFallback: true,
      port: app.config.port,
      hostname: app.config.hostname,
      ...handlers,
    });
  }
  const server = state.server;

  let pending: ReturnType<typeof setTimeout> | null = null;

  /**
   * What the changes seen so far actually invalidate.
   *
   * Accumulated rather than replaced, because the debounce coalesces a burst:
   * saving a template and a stylesheet together must still rebuild the
   * stylesheet, not only whatever arrived last.
   */
  let needs: RefreshOptions = {};

  function scheduleReload(reason: string, what: RefreshOptions): void {
    needs = {
      routes: needs.routes || what.routes,
      islands: needs.islands || what.islands,
      styles: needs.styles || what.styles,
    };

    if (pending) clearTimeout(pending);
    pending = setTimeout(async () => {
      pending = null;
      const requested = needs;
      needs = {};
      try {
        await app.refresh(requested);
        for (const socket of sockets) socket.send("reload");
        console.log(`[stoneware] rebuilt (${reason})`);
      } catch (error) {
        console.error("[stoneware] rebuild failed:", error);

        // Also to the browser. A failed rebuild leaves the page showing stale
        // output, and a terminal the developer may not be looking at is a poor
        // place for the only notice of that.
        const detail = formatBuildFailure(error, app.config.root);
        for (const socket of sockets) socket.send(`error:${detail}`);
      }
    }, DEBOUNCE_MS);
  }

  // public/ is watched too: editing a stylesheet is as much an edit as editing
  // a template, and without it CSS changes appear only on a manual refresh.
  //
  // What each directory can invalidate is not the same, and treating them alike
  // is what made every save re-bundle every island:
  //
  //   routes/   templates are re-imported by --hot; only a .css here is built
  //   islands/  source is bundled into client chunks, so a change rebuilds them
  //   lib/      imported by islands, so bundled into them too
  //   public/   served as-is and never built - reload the browser, nothing more
  const watched: { dir: string; invalidates: (file: string) => RefreshOptions }[] = [
    { dir: app.config.routesDir, invalidates: (file) => ({ routes: true, styles: isCSS(file) }) },
    { dir: app.config.islandsDir, invalidates: () => ({ islands: true }) },
    { dir: join(app.config.root, "lib"), invalidates: () => ({ islands: true }) },
    { dir: app.config.publicDir, invalidates: () => ({}) },
  ];

  state.watchers = watched
    .filter((entry) => directoryExists(entry.dir))
    .map((entry) =>
      watch(entry.dir, { recursive: true }, (_event, filename) => {
        const file = filename ? String(filename) : "";
        scheduleReload(file || entry.dir, entry.invalidates(file));
      }),
    );

  // Server modules were just re-evaluated with the new code, so the browser is
  // now the only stale copy.
  if (isReload) {
    for (const socket of sockets) socket.send("reload");
  }

  // Bound once. `process` outlives every re-evaluation, so registering here
  // each time would add a listener per edit until Node warns about a leak - and
  // they would close over a `server` that is no longer the live one.
  if (!state.signalsBound) {
    state.signalsBound = true;
    const shutdown = () => {
      for (const watcher of state.watchers) watcher.close();
      state.server?.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  if (isReload) {
    console.log("[stoneware] server modules reloaded");
    return;
  }

  const count = state.watchers.length;
  const url = `http://${app.config.hostname}:${server.port}`;
  console.log(`[stoneware] dev server on ${url}`);
  console.log(`[stoneware] watching ${count} director${count === 1 ? "y" : "ies"}`);

  // Only on a first start. `bun --hot` re-evaluates this module on every edit,
  // so opening unconditionally would spawn a browser tab per keystroke-save.
  if (options.open && !isReload) openBrowser(url);
}

/**
 * Open the default browser, best-effort.
 *
 * Failure is ignored on purpose: there may be no browser, no display, or no
 * permission to spawn one, and none of those are reasons to stop a dev server
 * that has already started successfully.
 */
function openBrowser(url: string): void {
  const command =
    process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : process.platform === "darwin"
        ? ["open", url]
        : ["xdg-open", url];

  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // Nothing to say - the URL is already printed above.
  }
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
