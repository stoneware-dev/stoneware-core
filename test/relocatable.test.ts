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
