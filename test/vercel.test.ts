/**
 * `stoneware build --target vercel`.
 *
 * The target is thin on purpose - Vercel's Bun framework preset detects a
 * `Bun.serve()` call at module startup in a root-level `server.*` file, which is
 * what a built Stoneware server already does. These tests pin the two things
 * that would silently produce a deployment that 404s: the entrypoint being in
 * the place the preset looks, and an existing vercel.json never being
 * overwritten.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { emitVercel } from "../src/cli/vercel.ts";

const ROOT = join(import.meta.dir, "..", ".vercel-target-test");

// No real build here: emitting the target is pure file generation, and running
// a second concurrent Bun.build alongside relocatable.test.ts made both flaky on
// Windows. That the build actually puts a bundle at .stoneware/server.js is
// asserted where the build happens, in relocatable.test.ts.
beforeAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(join(ROOT, ".stoneware"), { recursive: true });
  await Bun.write(join(ROOT, ".stoneware", "server.js"), "// stand-in for the built bundle\n");
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("the entrypoint", () => {
  test("is written where the Bun preset looks for it", async () => {
    const result = await emitVercel(ROOT);
    expect(result.entrypoint).toBe(join(ROOT, "server.js"));
    expect(await Bun.file(result.entrypoint).exists()).toBe(true);
  });

  test("imports the bundle for its side effect, not for a handler", async () => {
    // The preset detects the Bun.serve() call that happens as the bundle
    // evaluates. Re-exporting a handler instead would leave the server unstarted
    // and every request unrouted.
    const source = await Bun.file(join(ROOT, "server.js")).text();
    expect(source).toContain('import ".stoneware/server.js"');
    expect(source).not.toContain("export default");
  });

  test("does not overwrite a bundle that is already there", async () => {
    await emitVercel(ROOT);
    expect(await Bun.file(join(ROOT, ".stoneware", "server.js")).text()).toContain("stand-in");
  });
});

describe("vercel.json", () => {
  test("is created selecting both the preset and the runtime", async () => {
    await rm(join(ROOT, "vercel.json"), { force: true });
    const result = await emitVercel(ROOT);

    expect(result.wroteConfig).toBe(true);
    const config = await Bun.file(join(ROOT, "vercel.json")).json();

    // Without the preset, Vercel treats the project as a static build: no
    // function is created and every path 404s while the build reports success.
    expect(config.framework).toBe("bun");
    // Without this the function runs on Node, where Bun.serve does not exist.
    expect(config.bunVersion).toBe("1.x");
    expect(config.buildCommand).toContain("--target vercel");
  });

  test("carries no functions block", async () => {
    // `functions` patterns only match Serverless Functions inside api/, so one
    // here fails the preset build outright: "The pattern server.js doesn't match
    // any Serverless Functions inside the api directory." There is no
    // includeFiles for the preset - the build is relocatable instead.
    await rm(join(ROOT, "vercel.json"), { force: true });
    await emitVercel(ROOT);

    const config = await Bun.file(join(ROOT, "vercel.json")).json();
    expect(config.functions).toBeUndefined();
  });

  test("a complete existing config is left alone", async () => {
    const custom =
      '{\n  "framework": "bun",\n  "bunVersion": "1.x",\n  "regions": ["bom1"]\n}\n';
    await Bun.write(join(ROOT, "vercel.json"), custom);

    const result = await emitVercel(ROOT);

    expect(result.wroteConfig).toBe(false);
    expect(result.configNote).toBeNull();
    // Hand-maintained deployment config - regions, headers, redirects - is not
    // ours to rewrite for the sake of one field.
    expect(await Bun.file(join(ROOT, "vercel.json")).text()).toBe(custom);
  });

  test("an incomplete existing config is reported, not patched", async () => {
    const custom = '{\n  "regions": ["bom1"]\n}\n';
    await Bun.write(join(ROOT, "vercel.json"), custom);

    const result = await emitVercel(ROOT);

    expect(result.wroteConfig).toBe(false);
    expect(result.configNote).toMatch(/framework/);
    expect(result.configNote).toMatch(/bunVersion/);
    expect(await Bun.file(join(ROOT, "vercel.json")).text()).toBe(custom);
  });

  test("a functions block in an existing config is called out", async () => {
    const custom =
      '{\n  "framework": "bun",\n  "bunVersion": "1.x",\n' +
      '  "functions": { "server.js": { "includeFiles": "public/**" } }\n}\n';
    await Bun.write(join(ROOT, "vercel.json"), custom);

    const result = await emitVercel(ROOT);
    expect(result.configNote).toMatch(/functions/);
  });
});
