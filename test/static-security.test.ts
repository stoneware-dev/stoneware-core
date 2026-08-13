/**
 * The static-file and pre-authentication surface.
 *
 * Both cases here were found by probing a running app rather than by reading:
 * `public/` served dotfiles, and the CSRF token search parsed a body of any
 * size before any check had passed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/server.ts";
import type { StonewareApp } from "../src/server.ts";

const FIXTURE_ROOT = join(import.meta.dir, "fixture");
const PUBLIC = join(FIXTURE_ROOT, "public");

let app: StonewareApp;

beforeAll(async () => {
  writeFileSync(join(PUBLIC, ".env"), "SECRET=leaked\n");
  mkdirSync(join(PUBLIC, ".git"), { recursive: true });
  writeFileSync(join(PUBLIC, ".git", "config"), "[core]\n");
  mkdirSync(join(PUBLIC, ".well-known"), { recursive: true });
  writeFileSync(join(PUBLIC, ".well-known", "security.txt"), "Contact: mailto:a@b.c\n");

  app = await createApp(
    { root: FIXTURE_ROOT, csrf: { secret: "static-security-secret-01234" } },
    { dev: true },
  );
});

afterAll(() => {
  rmSync(join(PUBLIC, ".env"), { force: true });
  rmSync(join(PUBLIC, ".git"), { recursive: true, force: true });
  rmSync(join(PUBLIC, ".well-known"), { recursive: true, force: true });
});

const get = (path: string, init?: RequestInit) =>
  app.fetch(new Request(`http://localhost${path}`, init));

describe("dotfiles under public/", () => {
  test("are not served", async () => {
    // Nothing anyone deliberately publishes starts with a dot; several things
    // nobody wants published do.
    expect((await get("/.env")).status).toBe(404);
    expect((await get("/.git/config")).status).toBe(404);
    expect((await get("/.DS_Store")).status).toBe(404);
  });

  test("cannot be reached by encoding the dot", async () => {
    // The check runs after decoding, so %2E is not a way round it.
    expect((await get("/%2Egit/config")).status).toBe(404);
  });

  test("but .well-known is served, because specifications require it", async () => {
    // ACME challenges, security.txt and app-association files all live there.
    const response = await get("/.well-known/security.txt");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Contact:");
  });

  test("ordinary assets are unaffected", async () => {
    expect((await get("/styles.css")).status).toBe(200);
  });
});

describe("the body read that happens before verification", () => {
  test("a large body is refused without being parsed", async () => {
    // Token extraction runs before verification by necessity, which makes it
    // reachable by anyone. An unbounded parse there turns a few bytes of
    // attacker request into megabytes of server-side multipart work.
    const body = `message=${"x".repeat(2 * 1024 * 1024)}`;

    const started = performance.now();
    const response = await get("/api/echo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const elapsed = performance.now() - started;

    expect(response.status).toBe(403);
    expect(elapsed).toBeLessThan(1000);
  });

  test("the rejection explains how a large upload should send its token", async () => {
    const response = await get("/api/echo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `message=${"x".repeat(2 * 1024 * 1024)}`,
    });

    expect(await response.text()).toContain("header");
  });

  test("an ordinary form still finds its token in the body", async () => {
    // The cap must not break the common case it sits in front of.
    const html = await (await get("/")).text();
    const token = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
    expect(token).toBeDefined();

    const response = await get("/api/echo", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ _csrf: token!, message: "hi" }).toString(),
    });

    expect(response.status).toBe(200);
  });
});

describe("symbolic links out of public/", () => {
  // Verified against a real junction that served the framework's own source:
  // safeJoin checks the path textually, but a link is resolved when the file is
  // opened, so the two disagreed.
  const LINK = join(PUBLIC, "escape");

  test("are not followed by default", async () => {
    // Skipped where the platform will not let the test create a link at all.
    let made = false;
    try {
      symlinkSync(join(import.meta.dir, "..", "src"), LINK, "junction");
      made = true;
    } catch {
      return;
    }

    try {
      const guarded = await createApp(
        { root: FIXTURE_ROOT, csrf: { secret: "symlink-secret-0123456789ab" } },
        { dev: true },
      );
      const response = await guarded.fetch(new Request("http://localhost/escape/csrf.ts"));
      expect(response.status).toBe(404);

      // And an ordinary asset beside it is unaffected.
      expect((await guarded.fetch(new Request("http://localhost/styles.css"))).status).toBe(200);
    } finally {
      if (made) rmSync(LINK, { recursive: true, force: true });
    }
  });

  test("are followed when a project opts in", async () => {
    // A monorepo linking public/shared -> ../../assets is a real layout, so the
    // block has an escape hatch rather than being absolute.
    let made = false;
    try {
      symlinkSync(join(import.meta.dir, "..", "src"), LINK, "junction");
      made = true;
    } catch {
      return;
    }

    try {
      const permissive = await createApp(
        {
          root: FIXTURE_ROOT,
          csrf: { secret: "symlink-secret-0123456789ab" },
          followSymlinks: true,
        },
        { dev: true },
      );
      const response = await permissive.fetch(new Request("http://localhost/escape/csrf.ts"));
      expect(response.status).toBe(200);
    } finally {
      if (made) rmSync(LINK, { recursive: true, force: true });
    }
  });
});
