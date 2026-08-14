/**
 * `preview`, `routes` and `doctor`.
 *
 * The behaviours worth pinning are the ones that make each command worth having
 * rather than the ones that make it run: preview reproducing the export's own
 * URL conventions (and refusing traversal), routes reporting *match order*
 * rather than filesystem order, and doctor failing on the tsconfig mistake that
 * otherwise surfaces as an unrelated TypeError mid-render.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { doctor } from "../src/cli/doctor.ts";
import { exportSite } from "../src/cli/export.ts";
import { preview } from "../src/cli/preview.ts";
import { listRoutes } from "../src/cli/routes.ts";

const FIXTURE = join(import.meta.dir, "fixture");
const ROOT = join(import.meta.dir, "..", ".cli-commands-test");

let server: Bun.Server<undefined> | undefined;
let base = "";

beforeAll(async () => {
  process.env.STONEWARE_CSRF_SECRET = "cli-commands-secret-0123456789";
  await rm(ROOT, { recursive: true, force: true });
  await mkdir(ROOT, { recursive: true });
  await cp(FIXTURE, ROOT, { recursive: true });
  await rm(join(ROOT, ".stoneware"), { recursive: true, force: true });

  await exportSite(ROOT, join(ROOT, "dist"));

  const result = await preview(ROOT, "dist", 4790);
  server = result.server;
  base = `http://${result.hostname}:${result.port}`;
});

afterAll(async () => {
  server?.stop(true);
  await rm(ROOT, { recursive: true, force: true });
});

describe("preview", () => {
  test("serves a page written as <path>/index.html", async () => {
    expect((await fetch(`${base}/plain`)).status).toBe(200);
  });

  test("the trailing-slash spelling reaches the same page", async () => {
    // A static host serves one file for both, so a preview that answered only
    // one would report a problem the deploy does not have.
    expect((await fetch(`${base}/plain/`)).status).toBe(200);
  });

  test("serves assets copied from public/", async () => {
    expect((await fetch(`${base}/styles.css`)).status).toBe(200);
  });

  test("a miss is answered from 404.html with a 404", async () => {
    const response = await fetch(`${base}/no-such-page`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("<!DOCTYPE html>");
  });

  test("refuses to climb out of the export directory", async () => {
    // Reusing the server's safeJoin rather than reimplementing path safety is
    // the point: a second copy is how one of them ends up wrong.
    const response = await fetch(`${base}/../../package.json`);
    expect(response.status).toBe(404);
  });

  test("sends no Content-Security-Policy, like the host it imitates", async () => {
    // Adding it back would hide the single most important difference between
    // running the server and deploying an export.
    const response = await fetch(`${base}/plain`);
    expect(response.headers.get("content-security-policy")).toBeNull();
  });

  test("refuses to start when there is no export", async () => {
    await expect(preview(ROOT, "no-such-dir")).rejects.toThrow(/No export found/);
  });
});

describe("routes", () => {
  test("lists every route in the table", async () => {
    const { rows } = await listRoutes(ROOT);
    expect(rows.map((row) => row.pattern).sort()).toEqual([
      "/",
      "/api/echo",
      "/blog/[slug]",
      "/plain",
    ]);
  });

  test("orders by specificity, not by filename", async () => {
    // The reason the command exists: nothing about the filenames says which
    // pattern a request is tried against first.
    const { rows } = await listRoutes(ROOT);
    const literal = rows.findIndex((row) => row.pattern === "/api/echo");
    const dynamic = rows.findIndex((row) => row.pattern === "/blog/[slug]");
    expect(literal).toBeLessThan(dynamic);
  });

  test("separates pages from server actions", async () => {
    const { rows } = await listRoutes(ROOT);
    const echo = rows.find((row) => row.pattern === "/api/echo");
    const plain = rows.find((row) => row.pattern === "/plain");

    expect(echo?.kind).toBe("action");
    expect(echo?.methods).toEqual(["POST"]);
    expect(plain?.kind).toBe("page");
  });
});

describe("doctor", () => {
  test("passes on a well-formed project", async () => {
    await Bun.write(
      join(ROOT, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "stoneware" } }),
    );
    await Bun.write(join(ROOT, ".gitignore"), ".stoneware/\n.env\n");

    const result = await doctor(ROOT);
    expect(result.errors).toBe(0);
  });

  test("fails on JSX pointed at React's runtime", async () => {
    // The check worth having most: this compiles cleanly and then fails during a
    // render, blaming a template that is correct.
    await Bun.write(
      join(ROOT, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" } }),
    );

    const result = await doctor(ROOT);
    expect(result.errors).toBeGreaterThan(0);
    expect(JSON.stringify(result.findings)).toMatch(/jsxImportSource/);
  });

  test("warns about a missing .gitignore rather than failing", async () => {
    await rm(join(ROOT, ".gitignore"), { force: true });
    await Bun.write(
      join(ROOT, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "stoneware" } }),
    );

    const result = await doctor(ROOT);
    expect(result.errors).toBe(0);
    expect(result.warnings).toBeGreaterThan(0);
  });

  test("reports a missing routes/ as an error", async () => {
    const empty = join(ROOT, "empty-project");
    await mkdir(empty, { recursive: true });

    const result = await doctor(empty);
    expect(result.errors).toBeGreaterThan(0);
    expect(JSON.stringify(result.findings)).toMatch(/routes/);
  });
});
