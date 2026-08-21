/**
 * The `head` export, and the preloads that ride into <head> with it.
 *
 * Run through the real pipeline rather than `buildDocument` directly, because
 * the ordering that matters here - body renders, then head is assembled - is a
 * property of the server, not of the document builder.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createApp } from "../src/http/server.ts";
import type { StonewareApp } from "../src/http/server.ts";

const FIXTURE_ROOT = join(import.meta.dir, "fixture-errors");

let app: StonewareApp;

beforeAll(async () => {
  app = await createApp(
    { root: FIXTURE_ROOT, csrf: { secret: "head-test-secret-0123456789ab" } },
    { dev: true },
  );
});

const get = async (path: string) =>
  await (await app.fetch(new Request(`http://localhost${path}`))).text();

const headOf = (html: string) => html.slice(0, html.indexOf("</head>"));

describe("the head export", () => {
  test("its markup reaches <head>", async () => {
    const head = headOf(await get("/seo"));

    expect(head).toContain('<meta name="description" content="From the head export">');
    expect(head).toContain('<link rel="canonical" href="https://example.com/seo">');
  });

  test("its <title> replaces the default rather than joining it", async () => {
    // Two titles in one document is never what was meant.
    const html = await get("/seo");

    expect(html).toContain("<title>Custom title</title>");
    expect(html.match(/<title/g)).toHaveLength(1);
  });

  test("it receives the same props as the page", async () => {
    // The canonical URL above is built from `url`, so its value proves this.
    expect(await get("/seo")).toContain("https://example.com/seo");
  });

  test("a page without a head export is unaffected", async () => {
    const html = await get("/");

    expect(html).toContain("<title>");
    expect(html).not.toContain("canonical");
  });
});

describe("preloads from the body reach the head", () => {
  test("a priority <Image> deep in the page contributes a preload", async () => {
    // The <img> is in <main>, which the assembler has long passed by the time
    // it renders - this is the whole reason the render context collects them.
    const head = headOf(await get("/seo"));

    expect(head).toContain('<link rel="preload" as="image" href="/hero.jpg">');
  });

  test("a non-priority image contributes nothing", async () => {
    expect(headOf(await get("/seo"))).not.toContain("later.jpg");
  });

  test("the images themselves still render in the body", async () => {
    const html = await get("/seo");
    const body = html.slice(html.indexOf("</head>"));

    expect(body).toContain('fetchpriority="high"');
    expect(body).toContain('loading="lazy"');
  });
});
