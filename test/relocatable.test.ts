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
import { build, inlineClientAssets } from "../src/cli/build.ts";
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
let entrySource = "";
let buildResult: BuildResult;

// The chunks the build emits, base64 by filename - the same values a
// --target vercel build carries inside the bundle. Derived from the build above
// rather than from a second one: two Bun.build calls in one process race on
// Windows reading signals-core.
let inlineAssets: Record<string, string> = {};

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
  entrySource = await Bun.file(join(buildDir, ".stoneware", "server-entry.ts")).text();

  // ...then move the result somewhere else entirely, and take the source tree
  // away. What is left is what a deploy artifact actually looks like.
  await cp(buildDir, runDir, { recursive: true });
  await rm(join(runDir, "routes"), { recursive: true, force: true });
  await rm(join(runDir, "islands"), { recursive: true, force: true });

  inlineAssets = await inlineClientAssets(join(buildDir, ".stoneware", "static"));
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

/* -------------------------------------------------------------------------- */

/**
 * Carrying the client chunks inside the bundle.
 *
 * The fifth instance of the same lesson. The chunks are found through a path
 * computed at runtime, so a platform that builds a function by tracing imports
 * never uploads them: every page answers 200 with correct markup while every
 * stylesheet and island chunk on it answers 404, which reads as a CSS bug
 * rather than a missing file.
 *
 * Copying them into `public/` was tried first and is not enough - Vercel
 * collects `public/` from the repository, so a directory the build creates is
 * not in the snapshot, and it is gitignored build output so committing it is
 * not an answer either. Carrying them as a value is the only form that cannot
 * be lost, because tracing follows a static import by definition.
 *
 * So the test is not "were they inlined". It is: serve with the build directory
 * and public/ both absent, and check the URLs the markup points at still answer.
 */
describe("client chunks travel inside the bundle when asked", () => {


  test("a default build does not carry them", () => {
    // buildDir was built without the option. Every byte here is paid for by a
    // deploy that does not need it - a container ships the directory itself.
    expect(entrySource).toContain("const inlineAssets = undefined;");
  });

  test("a chunk is served with nothing on disk at all", async () => {
    const app = await createApp(
      { root: join(import.meta.dir, "..", ".no-disk-at-all") },
      {
        dev: false,
        routeManifest: { "/": join(buildDir, "routes", "index.tsx") },
        preloadedRoutes: new Map([["/", await import(join(FIXTURE_ROOT, "routes", "index.tsx"))]]),
        islandManifest: { Badge: "/_stoneware/Badge-x.js" },
        stylesheet: "/_stoneware/styles-x.css",
        inlineAssets,
      },
    );

    const name = Object.keys(inlineAssets).find((file) => file.endsWith(".css"))!;
    const response = await app.fetch(new Request(`http://localhost/_stoneware/${name}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/css");
    // Hashed filenames, so a year of caching is correct and must survive the
    // change of source.
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    expect((await response.text()).length).toBeGreaterThan(0);
  });

  test("javascript keeps its own content type", async () => {
    const app = await createApp(
      { root: join(import.meta.dir, "..", ".no-disk-at-all") },
      {
        dev: false,
        routeManifest: { "/": join(buildDir, "routes", "index.tsx") },
        preloadedRoutes: new Map([["/", await import(join(FIXTURE_ROOT, "routes", "index.tsx"))]]),
        islandManifest: { Badge: "/_stoneware/Badge-x.js" },
        inlineAssets,
      },
    );

    const name = Object.keys(inlineAssets).find((file) => file.endsWith(".js"))!;
    const response = await app.fetch(new Request(`http://localhost/_stoneware/${name}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("javascript");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("a chunk that was never built is still a 404", async () => {
    const app = await createApp(
      { root: join(import.meta.dir, "..", ".no-disk-at-all") },
      {
        dev: false,
        routeManifest: { "/": join(buildDir, "routes", "index.tsx") },
        preloadedRoutes: new Map([["/", await import(join(FIXTURE_ROOT, "routes", "index.tsx"))]]),
        islandManifest: { Badge: "/_stoneware/Badge-x.js" },
        inlineAssets,
      },
    );

    expect((await app.fetch(new Request("http://localhost/_stoneware/nope.js"))).status).toBe(404);
  });
});

/**
 * The lookup key comes straight off the URL, which is the whole risk.
 *
 * These are separated from the tests above because they are not about whether
 * the feature works — they are about what it does when asked for something
 * nobody built.
 */
describe("asking the bundle for a chunk that is not in it", () => {
  const withAssets = async (assets: Record<string, string>) =>
    createApp(
      { root: FIXTURE_ROOT, csrf: { secret: "relocatable-test-secret-0123456789" } },
      {
        dev: false,
        routeManifest: { "/": join(FIXTURE_ROOT, "routes", "index.tsx") },
        preloadedRoutes: new Map([["/", await import(join(FIXTURE_ROOT, "routes", "index.tsx"))]]),
        islandManifest: { Badge: "/_stoneware/Badge-x.js" },
        inlineAssets: assets,
      },
    );

  const encode = (text: string) => Buffer.from(text).toString("base64");

  test("a key every object answers for is still a 404", async () => {
    // The bug this pins: the chunks arrived as a plain object, and
    // `assets["toString"]` is a function rather than undefined. That passed the
    // presence check and handed a function to a base64 decoder, so
    // `/_stoneware/toString` answered 500 - an unauthenticated request turning
    // into a server error. A Map has no inherited keys.
    const app = await withAssets({ "real.css": encode("body{}") });

    for (const key of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
      const response = await app.fetch(new Request(`http://localhost/_stoneware/${key}`));
      expect(response.status).toBe(404);
    }
  });

  test("traversal out of the prefix is refused", async () => {
    const app = await withAssets({ "real.css": encode("body{}") });

    for (const path of ["/_stoneware/..%2f..%2fpackage.json", "/_stoneware/../package.json"]) {
      expect((await app.fetch(new Request("http://localhost" + path))).status).toBe(404);
    }
  });

  test("an empty inline map behaves exactly as no map at all", async () => {
    // A project with no islands and no CSS builds to `{}`, and must not stop
    // serving public/ or start answering for chunks it never produced.
    const app = await withAssets({});

    expect((await app.fetch(new Request("http://localhost/styles.css"))).status).toBe(200);
    expect((await app.fetch(new Request("http://localhost/_stoneware/x.js"))).status).toBe(404);
  });
});

describe("what an inlined chunk is served as", () => {
  const encode = (text: string) => Buffer.from(text).toString("base64");

  let app: Awaited<ReturnType<typeof createApp>>;

  beforeAll(async () => {
    app = await createApp(
      { root: FIXTURE_ROOT, csrf: { secret: "relocatable-test-secret-0123456789" } },
      {
        dev: false,
        routeManifest: { "/": join(FIXTURE_ROOT, "routes", "index.tsx") },
        preloadedRoutes: new Map([["/", await import(join(FIXTURE_ROOT, "routes", "index.tsx"))]]),
        islandManifest: { Badge: "/_stoneware/Badge-x.js" },
        inlineAssets: {
          "styles-a.css": encode("body{color:red}"),
          "chunk-b.js": encode("export{}"),
          "empty.css": "",
          "font-c.woff2": Buffer.from([0x77, 0x4f, 0x46, 0x32]).toString("base64"),
          "weird.xyz": encode("data"),
          "nested/deep-d.js": encode("nested"),
        },
      },
    );
  });

  const get = (path: string) => app.fetch(new Request("http://localhost" + path));

  test("css and javascript keep their own content types", async () => {
    expect((await get("/_stoneware/styles-a.css")).headers.get("Content-Type")).toContain("text/css");
    expect((await get("/_stoneware/chunk-b.js")).headers.get("Content-Type")).toContain("javascript");
  });

  test("a font a stylesheet pulled in survives as bytes", async () => {
    // Why base64 rather than text: `asset: "[name]-[hash].[ext]"` puts whatever
    // the CSS referenced into the same directory, and some of it is binary.
    const response = await get("/_stoneware/font-c.woff2");
    expect(response.headers.get("Content-Type")).toBe("font/woff2");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([0x77, 0x4f, 0x46, 0x32]),
    );
  });

  test("an unrecognised extension is served as bytes, not guessed at", async () => {
    // A wrong Content-Type with nosniff set is worse than a generic one.
    expect((await get("/_stoneware/weird.xyz")).headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
  });

  test("an empty file is a 200 with no body, not a miss", async () => {
    const response = await get("/_stoneware/empty.css");
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test("a nested chunk path resolves", async () => {
    expect((await get("/_stoneware/nested/deep-d.js")).status).toBe(200);
  });

  test("a query string does not make it a different file", async () => {
    expect((await get("/_stoneware/styles-a.css?v=2")).status).toBe(200);
  });

  test("it leaves through the same exit as everything else", async () => {
    // Security headers and the CSP are applied at one point for every response;
    // a new branch that returned early would have skipped them.
    const response = await get("/_stoneware/styles-a.css");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
    expect(response.headers.get("Cache-Control")).toContain("immutable");
  });
});
