/**
 * A production build has to run somewhere other than where it was built.
 *
 * This is not a hypothetical: a container builds in one directory and runs in
 * another, a serverless function is unpacked into a scratch path, a CI job hands
 * an artifact to a deploy step. An earlier build wrote its build-time absolute
 * root into the bundle and matched routes by scanning `routes/` at request time,
 * so the output only worked on the machine that produced it - on Vercel every
 * request 404'd because the routes directory was not there to scan.
 *
 * The two guarantees below are what make the bundle portable, and both are the
 * kind that regress silently: nothing fails locally, because locally the build
 * path and the run path are the same directory.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { build } from "../src/cli/build.ts";
import type { BuildResult } from "../src/cli/build.ts";
import { createApp } from "../src/server.ts";
import { Router, scanRoutes } from "../src/router.ts";
import { emitVercel } from "../src/cli/vercel.ts";

const FIXTURE_ROOT = join(import.meta.dir, "fixture");

// Both live inside the repo: the fixture's config imports "stoneware", which
// needs the project's module resolution to find. They are still two different
// absolute paths, which is the only thing this suite depends on.
const buildDir = join(import.meta.dir, "..", ".relocatable-build");
const runDir = join(import.meta.dir, "..", ".relocatable-run-elsewhere");

let bundleText = "";
let buildResult: BuildResult;

beforeAll(async () => {
  process.env.STONEWARE_CSRF_SECRET = "relocatable-test-secret-0123456789";

  await rm(buildDir, { recursive: true, force: true });
  await rm(runDir, { recursive: true, force: true });

  // Build in one directory...
  await mkdir(buildDir, { recursive: true });
  await cp(FIXTURE_ROOT, buildDir, { recursive: true });
  await rm(join(buildDir, ".stoneware"), { recursive: true, force: true });
  buildResult = await build(buildDir);
  bundleText = await Bun.file(join(buildDir, ".stoneware", "server.js")).text();

  // ...then move the result somewhere else entirely, and take the source tree
  // away. What is left is what a deploy artifact actually looks like.
  await cp(buildDir, runDir, { recursive: true });
  await rm(join(runDir, "routes"), { recursive: true, force: true });
  await rm(join(runDir, "islands"), { recursive: true, force: true });
});

afterAll(async () => {
  await rm(buildDir, { recursive: true, force: true });
  await rm(runDir, { recursive: true, force: true });
});

describe("the built bundle carries no build-machine paths", () => {
  test("lands at the path the Vercel entrypoint imports", async () => {
    // `stoneware build --target vercel` writes a root server.js containing
    // `import "./.stoneware/server.js"`. If the build ever moves its output,
    // that import breaks and every request on Vercel 404s.
    expect(await Bun.file(join(buildDir, ".stoneware", "server.js")).exists()).toBe(true);
  });

  test("the build directory does not appear in the bundle", () => {
    // The specific failure this pins: `const root = "D:/projects/test"`.
    expect(bundleText).not.toContain(buildDir);
    expect(bundleText).not.toContain(buildDir.replace(/\\/g, "/"));
  });

  test("the root is derived from the bundle's own location", () => {
    expect(bundleText).toContain("import.meta.url");
  });

  test("routes are preloaded by pattern, not by absolute path", () => {
    expect(bundleText).toContain('"/blog/[slug]"');
    expect(bundleText).not.toContain("routes\\\\blog");
  });
});

describe("serving with no routes/ on disk", () => {
  test("the source tree really is gone", () => {
    expect(existsSync(join(runDir, "routes"))).toBe(false);
    expect(existsSync(join(runDir, ".stoneware", "server.js"))).toBe(true);
  });

  test("a page renders from the manifest alone", async () => {
    const manifest = { "/plain": join(runDir, "routes", "plain.tsx") };
    const module = await import(join(FIXTURE_ROOT, "routes", "plain.tsx"));

    const app = await createApp(
      { root: runDir },
      {
        dev: false,
        routeManifest: manifest,
        preloadedRoutes: new Map([["/plain", module]]),
      },
    );

    const response = await app.fetch(new Request("http://localhost/plain"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<!DOCTYPE html>");
  });

  test("islands still hydrate with islands/ gone", async () => {
    // The regression this pins was silent, which is what makes it worth a test:
    // the registry was rebuilt by rescanning islands/, so with the source tree
    // absent every island rendered as plain markup with no hydration marker and
    // no chunk reference. Pages looked fine and nothing was logged.
    const [index, badge, counter] = await Promise.all([
      import(join(FIXTURE_ROOT, "routes", "index.tsx")),
      import(join(FIXTURE_ROOT, "islands", "Badge.tsx")),
      import(join(FIXTURE_ROOT, "islands", "Counter.tsx")),
    ]);

    const app = await createApp(
      { root: runDir },
      {
        dev: false,
        routeManifest: { "/": join(runDir, "routes", "index.tsx") },
        preloadedRoutes: new Map([["/", index]]),
        preloadedIslands: new Map([
          ["Badge", badge.default],
          ["Counter", counter.default],
        ]),
      },
    );

    const html = await (await app.fetch(new Request("http://localhost/"))).text();

    expect(html).toContain('data-stoneware-island="Badge"');
    expect(html).toContain('data-stoneware-island="Counter"');
    expect(html).toContain('id="stoneware-islands"');
    expect(html).toMatch(/<script type="module" src="\/_stoneware\/Counter-[a-z0-9]+\.js">/);
  });

  test("a router given a manifest never touches the filesystem", async () => {
    // No routesDir is passed that exists, and init() must not care.
    const router = new Router(join(runDir, "routes"), {
      manifest: { "/plain": join(runDir, "routes", "plain.tsx") },
    });
    await expect(router.init()).resolves.toBeUndefined();
    expect(Object.keys(router.routes)).toEqual(["/plain"]);
  });

  test("without a manifest, a missing routes/ still fails loudly", async () => {
    // The manifest is an escape hatch for built output, not a way for a
    // misconfigured project to start up silently serving nothing.
    const router = new Router(join(runDir, "routes"));
    expect(router.init()).rejects.toThrow(/Routes directory not found/);
  });
});

describe("the manifest agrees with a filesystem scan", () => {
  test("same patterns, same files", async () => {
    // The build writes the manifest from scanRoutes, and the router matches
    // against the manifest. If those two ever describe different route tables,
    // production serves something development never saw.
    const scanned = scanRoutes(join(FIXTURE_ROOT, "routes"));

    const router = new Router(join(FIXTURE_ROOT, "routes"));
    await router.init();

    expect(Object.keys(router.routes).sort()).toEqual(Object.keys(scanned).sort());
  });
});

describe("the build reports what each island costs", () => {
  test("a size per island, largest first", () => {
    // "JavaScript is opt-in" is only a claim anyone can check if the cost is
    // shown at the moment it is incurred. Asserted here rather than in its own
    // file because this one already runs a real build, and two concurrent
    // Bun.build calls race on Windows.
    expect(buildResult.islandSizes.length).toBeGreaterThan(0);
    for (const island of buildResult.islandSizes) expect(island.bytes).toBeGreaterThan(0);

    const sizes = buildResult.islandSizes.map((island) => island.bytes);
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });

  test("every built island is named", () => {
    const names = buildResult.islandSizes.map((island) => island.name);
    expect(names).toContain("Counter");
    expect(names).toContain("Badge");
  });
});

describe("nothing is read from disk that a bundler cannot see", () => {
  test("the app starts with no .stoneware/ at all", async () => {
    // The Vercel failure, reduced. `server.js` statically imports the bundle, so
    // tracing carries that across - but islands.json and stylesheet.txt were
    // read through paths computed at runtime, which tracing cannot follow. The
    // bundle arrived, the manifest did not, and the server threw at boot:
    //
    //   Island manifest not found at /var/task/.stoneware/islands.json
    //
    // Passing both as values removes the read, so an empty directory is enough.
    const bare = join(import.meta.dir, "..", ".no-output-at-all");
    await rm(bare, { recursive: true, force: true });
    await mkdir(bare, { recursive: true });

    const [index, badge, counter] = await Promise.all([
      import(join(FIXTURE_ROOT, "routes", "index.tsx")),
      import(join(FIXTURE_ROOT, "islands", "Badge.tsx")),
      import(join(FIXTURE_ROOT, "islands", "Counter.tsx")),
    ]);

    const app = await createApp(
      { root: bare },
      {
        dev: false,
        routeManifest: { "/": join(bare, "routes", "index.tsx") },
        preloadedRoutes: new Map([["/", index]]),
        preloadedIslands: new Map([
          ["Badge", badge.default],
          ["Counter", counter.default],
        ]),
        islandManifest: {
          Badge: "/_stoneware/Badge-test.js",
          Counter: "/_stoneware/Counter-test.js",
        },
        stylesheet: "/_stoneware/styles-test.css",
      },
    );

    const html = await (await app.fetch(new Request("http://localhost/"))).text();

    expect(html).toContain('data-stoneware-island="Badge"');
    expect(html).toContain('src="/_stoneware/Counter-test.js"');
    expect(html).toContain('href="/_stoneware/styles-test.css"');

    await rm(bare, { recursive: true, force: true });
  });

  test("without the manifest it still fails loudly", async () => {
    // The inlined value is how a build hands the manifest over, not a way for a
    // project with no build output to start up serving broken pages.
    const bare = join(import.meta.dir, "..", ".no-output-either");
    await rm(bare, { recursive: true, force: true });
    await mkdir(bare, { recursive: true });

    const index = await import(join(FIXTURE_ROOT, "routes", "index.tsx"));

    expect(
      createApp(
        { root: bare },
        {
          dev: false,
          routeManifest: { "/": join(bare, "routes", "index.tsx") },
          preloadedRoutes: new Map([["/", index]]),
        },
      ),
    ).rejects.toThrow(/Island manifest not found/);

    await rm(bare, { recursive: true, force: true });
  });

  test("the generated entry carries the manifest as a value", async () => {
    // If this stops being inlined, the runtime read comes back and the next
    // serverless deploy fails the same way.
    expect(bundleText).toContain("islandManifest");
    expect(bundleText).toMatch(/Counter-[a-z0-9]+\.js/);
  });

  test("stoneware.config.ts is imported, not loaded from a computed path", async () => {
    // The third instance of the same mistake, found while adding `observe`.
    // The config was imported at boot through a path built from the project
    // root, which import tracing cannot follow - so on a platform that ships
    // only what it can see imported, the file never arrived. `loadConfigFile`
    // returns {} for a file that is not there, so nothing failed: the app came
    // up on defaults, with the project's csp, cors, trustProxy and observer
    // silently absent.
    //
    // A static import also happens to be the only form that can carry
    // `observe`, since a function survives no serialised representation.
    const entry = await Bun.file(join(buildDir, ".stoneware", "server-entry.ts")).text();
    expect(entry).toContain("import * as userConfigModule from");
    expect(entry).toContain("readConfigModule(userConfigModule");

    // And the values really are in the output: the fixture's config sets this
    // secret, so its presence means the module was inlined rather than left as
    // a reference to a file on the build machine.
    expect(bundleText).toContain("fixture-secret-value-0123456789");
  });
});

describe("the server bundle is compact but still debuggable", () => {
  // Two halves of one decision, and asserting only the first would let the
  // second regress silently.
  //
  // Whitespace is stripped because this bundle ships in a container image or a
  // serverless function and nothing reads it. Identifiers are *not*, because
  // the moment something throws in production the frame is the whole message:
  // `at Boom (routes/boom.tsx:3:14)` against `at e8 (routes/boom.tsx:2:22)`.
  // Measured, not assumed - full minification also constant-folds, which moved
  // the reported line and rewrote the error text from `value.missingProperty`
  // to `null.missingProperty`. Source maps recover neither.

  test("no readable module banners survive", () => {
    // Bun writes `// src/server.ts` between modules only when it is not
    // stripping whitespace, so this is the marker for the whole setting.
    expect(bundleText).not.toMatch(/^\/\/ src\//m);
  });

  test("the output is one long line per chunk, not formatted source", () => {
    const lines = bundleText.split("\n");
    expect(bundleText.length / lines.length).toBeGreaterThan(200);
  });

  test("function names are kept, so a stack trace still names the frame", () => {
    // If these start failing, minify gained `identifiers: true` and every
    // production stack trace became single letters.
    expect(bundleText).toContain("async function createApp");
    expect(bundleText).toContain("function renderToString");
  });

  test("a source map is still emitted and linked", async () => {
    expect(bundleText).toContain("sourceMappingURL");
    expect(await Bun.file(join(buildDir, ".stoneware", "server.js.map")).exists()).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The client assets have to reach the platform, not only the build directory.
 *
 * The last member of the same family. The server locates island chunks and the
 * stylesheet under `.stoneware/static/` - a path it computes at runtime - and a
 * platform that builds a function by tracing imports cannot see a computed
 * path. The bundle arrives, the assets do not.
 *
 * The failure shape is what makes it worth pinning: every page answers 200 with
 * correct markup, and every stylesheet and island chunk on it 404s. The site
 * looks deployed and arrives unstyled and inert, which reads as a CSS bug
 * rather than a missing file.
 *
 * Lives in this file rather than its own because it needs a real build, and two
 * concurrent `Bun.build` calls race on Windows reading signals-core.
 */
describe("client assets reach a platform that ships only what it traced", () => {
  const traced = join(import.meta.dir, "..", ".vercel-assets-traced");
  let emitted: Awaited<ReturnType<typeof emitVercel>>;
  let base = "";

  beforeAll(async () => {
    emitted = await emitVercel(buildDir);

    // Keep only what import tracing can follow, plus public/ - which the
    // platform ships because it is a platform convention, not a computed path.
    await rm(traced, { recursive: true, force: true });
    await mkdir(join(traced, ".stoneware"), { recursive: true });
    await cp(join(buildDir, ".stoneware", "server.js"), join(traced, ".stoneware", "server.js"));
    await cp(join(buildDir, "server.js"), join(traced, "server.js"));
    await cp(join(buildDir, "stoneware.config.ts"), join(traced, "stoneware.config.ts"));
    await cp(join(buildDir, "public"), join(traced, "public"), { recursive: true });

    process.env.PORT = "4763";
    await import(Bun.pathToFileURL(join(traced, ".stoneware", "server.js")).href);
    await Bun.sleep(400);
    base = "http://localhost:4763";
  });

  afterAll(async () => {
    await rm(traced, { recursive: true, force: true });
  });

  test("the chunks are copied where the platform will ship them", () => {
    expect(emitted.copiedAssets).toBeGreaterThan(0);
    expect(existsSync(join(buildDir, "public", "_stoneware"))).toBe(true);
  });

  test("the copy is emptied rather than merged into", async () => {
    // Filenames carry a content hash, so merging would accumulate every chunk
    // from every previous build and grow the deployment forever.
    const stale = join(buildDir, "public", "_stoneware", "Counter-fromlastbuild.js");
    await Bun.write(stale, "// left over");

    await emitVercel(buildDir);
    expect(existsSync(stale)).toBe(false);
  });

  test("the build directory really is absent from what was traced", () => {
    expect(existsSync(join(traced, ".stoneware", "static"))).toBe(false);
    expect(existsSync(join(traced, ".stoneware", "server.js"))).toBe(true);
  });

  test("the stylesheet the page links to actually answers", async () => {
    // The regression: 200 for the page, 404 for this, and a site that arrives
    // unstyled with nothing in the log to say why.
    const html = await (await fetch(`${base}/`)).text();
    const href = html.match(/href="(\/_stoneware\/styles-[^"]+\.css)"/)?.[1];
    expect(href).toBeDefined();

    const css = await fetch(base + href!);
    expect(css.status).toBe(200);
    expect(await css.text()).toContain("{");
  });

  test("the island chunk the page references actually answers", async () => {
    const html = await (await fetch(`${base}/`)).text();
    const src = html.match(/src="(\/_stoneware\/[^"]+\.js)"/)?.[1];
    expect(src).toBeDefined();
    expect((await fetch(base + src!)).status).toBe(200);
  });

  test("hashed assets keep their immutable caching through the fallback", async () => {
    // Serving them from public/ must not quietly downgrade a year of caching
    // into a revalidation on every request.
    const html = await (await fetch(`${base}/`)).text();
    const href = html.match(/href="(\/_stoneware\/styles-[^"]+\.css)"/)?.[1]!;

    const cache = (await fetch(base + href)).headers.get("cache-control");
    expect(cache).toContain("immutable");
    expect(cache).toContain("max-age=31536000");
  });

  test("an asset that exists nowhere is still a 404", async () => {
    expect((await fetch(`${base}/_stoneware/no-such-chunk.js`)).status).toBe(404);
  });

  test("traversal out of the asset directory is still refused", async () => {
    expect((await fetch(`${base}/_stoneware/..%2F..%2Fstoneware.config.ts`)).status).toBe(404);
  });
});
