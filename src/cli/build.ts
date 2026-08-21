/**
 * `stoneware build` - the production build (CLAUDE.md §11).
 *
 * Two independent outputs:
 *   1. One server bundle, with every route and island statically imported so no
 *      transpilation happens at request time.
 *   2. One client chunk per island, plus a shared runtime chunk, each named by
 *      content hash.
 *
 * The bundle is *relocatable*: it carries a route manifest instead of a
 * filesystem scan, and derives the project root from its own location rather
 * than from wherever it happened to be built. Both matter because the machine
 * that runs a build is routinely not the machine that serves it - a container
 * image, a serverless function, a CI artifact. An earlier build baked its
 * absolute build-time root into the bundle, which made the output unservable
 * anywhere but the machine that produced it.
 */

import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { buildIslands, buildStyles } from "../build/build.ts";
import { findConfigFile, loadConfigFile, resolveConfig } from "../config.ts";
import { discoverIslands } from "../build/islands.ts";
import { Router } from "../routing/router.ts";

export interface BuildResult {
  serverBundle: string;
  islandCount: number;
  routeCount: number;
  /** Client chunk sizes in bytes, by island name. Sorted largest first. */
  islandSizes: { name: string; bytes: number }[];
}

export async function build(root: string, options: BuildOptions = {}): Promise<BuildResult> {
  const userConfig = await loadConfigFile(root);
  const config = resolveConfig({ ...userConfig, root }, false);

  await rm(config.outDir, { recursive: true, force: true });
  await mkdir(config.outDir, { recursive: true });

  // --- Islands: one browser chunk each, plus the shared runtime chunk. -------
  const islands = await discoverIslands(config.islandsDir);
  const { manifest, staticDir } = await buildIslands({
    islands,
    outDir: config.outDir,
    dev: false,
  });

  // The whole premise is that JavaScript is opt-in, and an opt-in cost that is
  // never shown is not a cost anyone weighs. Reported per island so the number
  // sits next to the name of the thing that caused it.
  const islandSizes = (
    await Promise.all(
      Object.entries(manifest).map(async ([name, chunk]) => ({
        name,
        bytes: await Bun.file(join(staticDir, basename(chunk))).size,
      })),
    )
  ).sort((a, b) => b.bytes - a.bytes);

  // Built here rather than left to the server: the hashed URL has to reach the
  // bundle as a value, for the same reason the manifest does.
  const stylesheet = await buildStyles({
    dirs: [config.routesDir, config.islandsDir, join(config.root, "lib")],
    outDir: config.outDir,
    dev: false,
  });

  // --- Server: every route inlined into a single bundle. --------------------
  const router = new Router(config.routesDir);
  await router.init();
  const routes = Object.entries(router.routes).map(([pattern, file]) => ({
    pattern,
    absolute: resolve(file),
    // Relative to the project root, so the manifest describes the project
    // rather than the machine. Only ever used for diagnostics at runtime: every
    // route is inlined, so nothing is imported from this path.
    relative: relative(root, resolve(file)).replace(/\\/g, "/"),
  }));

  const entryPath = join(config.outDir, "server-entry.ts");
  await Bun.write(
    entryPath,
    serverEntrySource({
      // How to get from the bundle back to the project root at runtime. The
      // bundle lands in outDir, so this is usually "..", but outDir is
      // configurable and may be nested.
      rootFromOutDir: (relative(config.outDir, root) || ".").replace(/\\/g, "/"),
      routes,
      islandPaths: islands,
      manifest,
      stylesheet,
      // Imported statically below rather than read at runtime, for the same
      // reason the manifest is inlined - and because a config value can be a
      // function (`observe`), which no serialised form would carry.
      configPath: await findConfigFile(root),
      // Only when the target needs it: a bundle that ships beside its own
      // directory should not carry a second copy of every chunk.
      inlineAssets: options.inlineAssets ? await inlineClientAssets(staticDir) : null,
    }),
  );

  const result = await Bun.build({
    entrypoints: [entryPath],
    outdir: config.outDir,
    target: "bun",
    format: "esm",
    // Whitespace only, and the two halves left off are the point.
    //
    // This bundle is never sent to a browser, so the question is not how small
    // it can be made but what each byte saved costs when something breaks in
    // production. Measured on the documentation site, by building each variant
    // and making a route throw:
    //
    //   none         270 KB   at Boom (routes/boom.tsx:3:14)
    //   whitespace   221 KB   at Boom (routes/boom.tsx:3:14)
    //   +syntax      213 KB   at Boom (routes/boom.tsx:2:22)   line moved
    //   +identifiers 199 KB   at e8   (routes/boom.tsx:2:22)   name gone
    //
    // Whitespace removal is free: 18% smaller with the frame, line, column and
    // error text all identical to an unminified build. Beyond it, `syntax`
    // constant-folds - which moved the reported line and rewrote the error
    // message from `value.missingProperty` to `null.missingProperty`, pointing
    // at the wrong thing - and `identifiers` replaces the function name with
    // `e8`. Source maps do not recover either. The remaining ~10% gzipped is
    // not worth that on a bundle nobody downloads.
    minify: { whitespace: true, syntax: false, identifiers: false },
    sourcemap: "linked",
    naming: { entry: "server.js" },
  });

  if (!result.success) {
    throw new Error(`Server build failed:\n${result.logs.map(String).join("\n")}`);
  }

  return {
    serverBundle: join(config.outDir, "server.js"),
    islandCount: Object.keys(manifest).length,
    routeCount: routes.length,
    islandSizes,
  };
}

interface RouteEntry {
  pattern: string;
  absolute: string;
  relative: string;
}

interface EntrySourceOptions {
  /** Path from the build output directory back to the project root. */
  rootFromOutDir: string;
  routes: RouteEntry[];
  islandPaths: { name: string; path: string }[];
  /** Inlined so the served bundle never reads islands.json off disk. */
  manifest: Record<string, string>;
  /** Inlined for the same reason. */
  stylesheet: string | null;
  /** Absolute path to `stoneware.config.ts`, or null if the project has none. */
  configPath: string | null;
  /**
   * Client chunks carried inside the bundle, base64 by filename.
   *
   * Only for targets that ship a traced function. See `inlineClientAssets`.
   */
  inlineAssets: Record<string, string> | null;
}

export interface BuildOptions {
  /**
   * Carry the built client chunks inside the server bundle.
   *
   * The fifth instance of the same lesson, and the one that finally forced the
   * general fix. The chunks live under `.stoneware/static/` and are served from
   * a path computed at runtime, which a platform that traces imports cannot
   * see. Copying them into `public/` was tried first and does not work on
   * Vercel either: `public/` is collected from the repository, so a directory
   * the build creates is never in the snapshot - and it is gitignored build
   * output, so committing it is not an answer.
   *
   * Inlining is the one form that cannot be lost, because tracing follows a
   * static import by definition. It costs bundle size, so it is opt-in and set
   * only by `--target vercel`; a VPS or container ships the directory and needs
   * none of this.
   */
  inlineAssets?: boolean;
}

/**
 * Read the built client chunks as base64, keyed by filename.
 *
 * base64 rather than text because a stylesheet can pull a font or an image into
 * the same directory through `asset: "[name]-[hash].[ext]"`, and those are
 * binary. The 33% overhead is worth not having a second code path that decides
 * which files are safe to embed as strings.
 */
export async function inlineClientAssets(staticDir: string): Promise<Record<string, string>> {
  const assets: Record<string, string> = {};
  if (!existsSync(staticDir)) return assets;

  const glob = new Bun.Glob("**/*");
  for await (const name of glob.scan({ cwd: staticDir, onlyFiles: true })) {
    const bytes = await Bun.file(join(staticDir, name)).bytes();
    assets[name.replace(/\\/g, "/")] = Buffer.from(bytes).toString("base64");
  }
  return assets;
}

/**
 * Generate the server entry.
 *
 * Static imports are what make this a real bundle: the routes and islands end
 * up inside `server.js` rather than being pulled off disk per request. The
 * import specifiers below are build-machine paths, but Bun resolves them at
 * build time and inlines the modules, so none of them survive into the output.
 * Anything that *does* survive - the manifest, the preload keys, the root - is
 * written relative instead.
 */
function serverEntrySource(options: EntrySourceOptions): string {
  const toImport = (path: string) => JSON.stringify(path.replace(/\\/g, "/"));

  const lines: string[] = [
    "// Generated by `stoneware build`. Do not edit.",
    'import { dirname, resolve } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    `import { serve } from ${toImport(join(import.meta.dir, "..", "http", "server.ts"))};`,
    `import { readConfigModule } from ${toImport(join(import.meta.dir, "..", "config.ts"))};`,
    "",
  ];

  // A static import, so the bundler inlines the config the same way it inlines
  // the routes. It used to be loaded at runtime through a path built from the
  // project root, which is the exact shape a function bundler cannot trace: on
  // a platform that ships only what it can see imported, the file never
  // arrived, `loadConfigFile` found nothing, and the app silently ran on
  // defaults - no csp override, no cors, no trustProxy, no observer. It is also
  // what lets `observe` be a function at all; nothing serialised could carry one.
  if (options.configPath !== null) {
    lines.push(`import * as userConfigModule from ${toImport(options.configPath)};`);
  }

  options.routes.forEach((route, index) => {
    lines.push(`import * as route${index} from ${toImport(route.absolute)};`);
  });
  options.islandPaths.forEach((island, index) => {
    lines.push(`import island${index} from ${toImport(island.path)};`);
  });

  lines.push(
    "",
    "// Derived from where this bundle actually is, not from where it was built.",
    "const here = dirname(fileURLToPath(import.meta.url));",
    `const root = resolve(here, ${JSON.stringify(options.rootFromOutDir)});`,
    "",
    "// Pattern table, so the router never scans routes/ at runtime.",
    "const routeManifest = {",
    ...options.routes.map(
      (route) =>
        `  ${JSON.stringify(route.pattern)}: resolve(root, ${JSON.stringify(route.relative)}),`,
    ),
    "};",
    "",
    "const preloadedRoutes = new Map([",
    ...options.routes.map(
      (route, index) => `  [${JSON.stringify(route.pattern)}, route${index}],`,
    ),
    "]);",
    "",
    "const preloadedIslands = new Map([",
    ...options.islandPaths.map(
      (island, index) => `  [${JSON.stringify(island.name)}, island${index}],`,
    ),
    "]);",
    "",
    "// Inlined: a path computed at runtime is invisible to a function bundler,",
    "// so reading these from disk is what left them behind on Vercel.",
    `const islandManifest = ${JSON.stringify(options.manifest)};`,
    `const stylesheet = ${JSON.stringify(options.stylesheet)};`,
    // Carried as values for the same reason, and for the strongest version of
    // it: on a platform that traces imports these files are not merely read
    // through a computed path, they are never uploaded at all.
    options.inlineAssets === null
      ? "const inlineAssets = undefined;"
      : `const inlineAssets = ${JSON.stringify(options.inlineAssets)};`,
    "",
    options.configPath === null
      ? "const userConfig = {};"
      : `const userConfig = readConfigModule(userConfigModule, ${JSON.stringify(
          basename(options.configPath),
        )});`,
    // serve() rather than Bun.serve() directly: it owns binding, and it owns
    // deciding whether this process is one of several sharing the port. An
    // entry that called Bun.serve itself was a second definition of how the
    // server boots, and the multi-process path silently did not apply to it.
    "const { server, workers } = await serve(",
    "  { ...userConfig, root },",
    "  {",
    "    dev: false,",
    "    preloadedRoutes,",
    "    preloadedIslands,",
    "    routeManifest,",
    "    islandManifest,",
    "    stylesheet,",
    "    inlineAssets,",
    "  },",
    ");",
    "",
    // Only the primary announces the server. Every worker binding the same
    // port would otherwise print the same line, which reads like the server
    // restarting several times.
    "if (process.env.STONEWARE_WORKER_ID === undefined) {",
    "  const scale = workers > 1 ? ` (${workers} workers)` : ``;",
    "  console.log(`[stoneware] serving on http://${server.hostname}:${server.port}${scale}`);",
    "}",
    "",
  );

  return lines.join("\n");
}

/** Human-readable summary for the CLI. */
export function describeBuild(result: BuildResult, root: string): string {
  const lines = [
    `  server   ${relative(root, result.serverBundle).replace(/\\/g, "/")}`,
    `  routes   ${result.routeCount}`,
    `  islands  ${result.islandCount}`,
  ];

  // Per island, because a total tells you the page is heavy and a breakdown
  // tells you which component made it heavy.
  for (const { name, bytes } of result.islandSizes) {
    lines.push(`             ${name.padEnd(20)} ${formatBytes(bytes)}`);
  }

  if (result.islandSizes.length > 1) {
    const total = result.islandSizes.reduce((sum, island) => sum + island.bytes, 0);
    lines.push(`             ${"total".padEnd(20)} ${formatBytes(total)}`);
  }

  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} kB`;
}
