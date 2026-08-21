/**
 * The startup listing that lets a page request skip the filesystem.
 *
 * Two things have to hold for this to be safe. It must never serve something
 * `safeJoin` would refuse — the index is consulted first, so a bug here would
 * be a bug in front of every path defence. And it must never answer 404 for a
 * file that is really there, which is why a directory holding symlinks opts out
 * of indexing entirely rather than guessing at what a link points to.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildStaticIndex } from "../src/http/static.ts";

const ROOT = join(tmpdir(), `stoneware-static-index-${Date.now()}`);
const PLAIN = join(ROOT, "plain");
const LINKED = join(ROOT, "linked");
const OUTSIDE = join(ROOT, "outside");

beforeAll(() => {
  mkdirSync(join(PLAIN, "nested"), { recursive: true });
  writeFileSync(join(PLAIN, "styles.css"), "body{}");
  writeFileSync(join(PLAIN, "nested", "app.js"), "0");
  writeFileSync(join(PLAIN, ".env"), "SECRET=1");
  mkdirSync(join(PLAIN, ".well-known"), { recursive: true });
  writeFileSync(join(PLAIN, ".well-known", "security.txt"), "Contact: x");

  mkdirSync(OUTSIDE, { recursive: true });
  writeFileSync(join(OUTSIDE, "secret.txt"), "no");
  mkdirSync(LINKED, { recursive: true });
  writeFileSync(join(LINKED, "real.css"), "body{}");
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("buildStaticIndex", () => {
  test("contains the files that are really there", () => {
    const index = buildStaticIndex(PLAIN)!;
    expect(index).not.toBeNull();
    expect(index.has("/styles.css")).toBe(true);
    expect(index.has("/nested/app.js")).toBe(true);
  });

  test("does not contain paths that are not files", () => {
    const index = buildStaticIndex(PLAIN)!;
    expect(index.has("/articles/some-slug")).toBe(false);
    expect(index.has("/nested")).toBe(false);
    expect(index.has("/nope.css")).toBe(false);
  });

  test("still lists dotfiles, leaving the refusal to safeJoin", () => {
    // The index is a listing, not a policy. isHiddenPath is what refuses these,
    // and it has to keep being the thing that refuses them - a second, quieter
    // rule in a different file is how the two drift apart.
    const index = buildStaticIndex(PLAIN)!;
    expect(index.has("/.env")).toBe(true);
    expect(index.has("/.well-known/security.txt")).toBe(true);
  });

  test("a missing directory yields an index that matches nothing", () => {
    const index = buildStaticIndex(join(ROOT, "does-not-exist"))!;
    expect(index).not.toBeNull();
    expect(index.has("/anything")).toBe(false);
  });

  test("percent-encoded paths are decoded before lookup", () => {
    const dir = join(ROOT, "encoded");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a file.css"), "body{}");

    const index = buildStaticIndex(dir)!;
    expect(index.has("/a%20file.css")).toBe(true);
  });

  test("an undecodable path is passed through rather than judged", () => {
    // safeJoin rejects it with a reason; the index has no business pre-empting
    // that with a bare 404.
    const index = buildStaticIndex(PLAIN)!;
    expect(index.has("/%E0%A4%A")).toBe(true);
  });

  test("traversal never matches, so it can only ever fall through", () => {
    const index = buildStaticIndex(PLAIN)!;
    expect(index.has("/../outside/secret.txt")).toBe(false);
    expect(index.has("/..%2Foutside%2Fsecret.txt")).toBe(false);
  });

  test("a directory containing a symlink opts out of indexing", () => {
    // A link may point at a directory whose children this walk never sees.
    // Answering 404 for a file that exists is worse than the syscall saved, so
    // the whole directory falls back to asking the filesystem.
    try {
      symlinkSync(OUTSIDE, join(LINKED, "escape"), "dir");
    } catch {
      // Creating links needs privilege on Windows; skip rather than fail.
      return;
    }

    expect(buildStaticIndex(LINKED)).toBeNull();
  });
});

describe("case handling", () => {
  test("matches the filesystem's own case rules", () => {
    const index = buildStaticIndex(PLAIN)!;

    if (process.platform === "win32") {
      // NTFS would serve this, so the index must not be the thing that refuses
      // it - dev has no index, and the two must not disagree.
      expect(index.has("/Styles.CSS")).toBe(true);
    } else {
      expect(index.has("/Styles.CSS")).toBe(false);
    }
  });
});
