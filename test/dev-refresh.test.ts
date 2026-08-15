/**
 * What a dev rebuild actually redoes.
 *
 * Every file change used to redo all of it: re-import every island, re-bundle
 * every client chunk, re-emit the stylesheet. Editing a template invalidates
 * none of that, and on a two-island fixture it cost ~53ms on every save.
 *
 * Skipping work is only safe if the skipping is exact, and the failure mode is
 * the bad kind - a developer looking at stale output and trusting it. So these
 * assert by *effect*: the build output is deleted, one refresh is asked for, and
 * what comes back says what ran. Timing would prove nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/server.ts";
import type { StonewareApp } from "../src/server.ts";

const FIXTURE = join(import.meta.dir, "fixture");
// A copy, because these tests delete build output and the fixture's own
// .stoneware/ is read by other suites.
const ROOT = join(import.meta.dir, "..", ".dev-refresh-test");
const STATIC = join(ROOT, ".stoneware", "static");

let app: StonewareApp;

beforeAll(async () => {
  process.env.STONEWARE_CSRF_SECRET = "dev-refresh-secret-0123456789";
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  await cp(FIXTURE, ROOT, { recursive: true });
  await rm(join(ROOT, ".stoneware"), { recursive: true, force: true });

  app = await createApp({ root: ROOT }, { dev: true });
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

/** What is sitting in the static directory right now. */
function emitted(): { chunks: number; styles: number } {
  if (!existsSync(STATIC)) return { chunks: 0, styles: 0 };
  const files = readdirSync(STATIC);
  return {
    chunks: files.filter((name) => name.endsWith(".js")).length,
    styles: files.filter((name) => name.endsWith(".css")).length,
  };
}

async function wipe(): Promise<void> {
  await rm(STATIC, { recursive: true, force: true });
  expect(emitted()).toEqual({ chunks: 0, styles: 0 });
}

describe("a refresh only redoes what it is told changed", () => {
  test("the fixture emits both to begin with", () => {
    const { chunks, styles } = emitted();
    expect(chunks).toBeGreaterThan(0);
    expect(styles).toBe(1);
  });

  test("a public/ change rebuilds nothing", async () => {
    // public/ is served as-is and never built. The browser still reloads; the
    // server has no work to do.
    await wipe();
    await app.refresh({});
    expect(emitted()).toEqual({ chunks: 0, styles: 0 });
  });

  test("a template change rebuilds nothing", async () => {
    // The most common edit there is, and the one that used to cost the most for
    // no reason. Route modules are re-imported per request in dev; nothing
    // under routes/ is bundled.
    await wipe();
    await app.refresh({ routes: true });
    expect(emitted()).toEqual({ chunks: 0, styles: 0 });
  });

  test("a stylesheet change rebuilds the stylesheet and nothing else", async () => {
    await wipe();
    await app.refresh({ routes: true, styles: true });

    const { chunks, styles } = emitted();
    expect(styles).toBe(1);
    expect(chunks).toBe(0);
  });

  test("an island change rebuilds the chunks", async () => {
    await wipe();
    await app.refresh({ islands: true });
    expect(emitted().chunks).toBeGreaterThan(0);
  });

  test("an island change takes the stylesheet with it", async () => {
    // Not an optional extra: buildIslands clears the static directory, so a
    // stylesheet that was not rebuilt alongside would simply be gone - and the
    // page would render with a link to a file that is not there.
    await wipe();
    await app.refresh({ islands: true });
    expect(emitted().styles).toBe(1);

    // The framework's own hashed stylesheet, not the fixture's hand-written
    // link to a file in public/ - both are on the page.
    const html = await (await app.fetch(new Request("http://localhost/"))).text();
    const href = html.match(/href="(\/_stoneware\/styles-[^"]+\.css)"/)?.[1];
    expect(href).toBeDefined();
    expect(existsSync(join(STATIC, href!.split("/").pop()!))).toBe(true);
  });

  test("no argument still rebuilds everything", async () => {
    // The signature is backwards compatible on purpose: a caller that does not
    // know what changed must get the old, complete behaviour.
    await wipe();
    await app.refresh();

    const { chunks, styles } = emitted();
    expect(chunks).toBeGreaterThan(0);
    expect(styles).toBe(1);
  });

  test("pages still serve their islands after a partial refresh", async () => {
    // The registry lives beside the chunks. A refresh that skipped the island
    // rebuild must leave the previously loaded registry intact, or islands
    // silently degrade to inert markup - the exact failure 0.1.4 shipped.
    await app.refresh();
    await app.refresh({ routes: true });

    const html = await (await app.fetch(new Request("http://localhost/"))).text();
    expect(html).toContain('data-stoneware-island="Counter"');
    expect(html).toContain('id="stoneware-islands"');
  });
});
