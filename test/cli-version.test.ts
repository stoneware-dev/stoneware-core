/**
 * `stoneware --version`.
 *
 * Small, but it was missing and SECURITY.md asks reporters to run it. Worse than
 * missing: `--version` starts with a dash, so the old parser did not treat it as
 * a command, fell through to the usage text, and exited 1 — a flag that looks
 * like it printed something useful while actually reporting failure.
 *
 * Bun's version is included because it is half of any useful bug report. The
 * framework is built on Bun's primitives and one of them has already shipped a
 * request-triggerable panic, so "which Bun?" is always the next question.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "bin", "stoneware.mjs");

async function run(...args: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  return { out, code: await proc.exited };
}

describe("--version", () => {
  test("prints both versions and exits 0", async () => {
    const { out, code } = await run("--version");

    expect(code).toBe(0);
    expect(out).toMatch(/^stoneware \d+\.\d+\.\d+ \(bun \d+\.\d+\.\d+\)/);
  });

  test("-v is the same", async () => {
    const [long, short] = await Promise.all([run("--version"), run("-v")]);
    expect(short.out).toBe(long.out);
  });

  test("reports the version this package actually declares", async () => {
    // Read from package.json rather than hardcoded, so a release bump does not
    // fail the suite - but pinned, so the CLI cannot drift from the manifest.
    const manifest = join(import.meta.dir, "..", "package.json");
    const { version } = (await Bun.file(manifest).json()) as { version: string };

    const { out } = await run("--version");
    expect(out).toContain(`stoneware ${version}`);
  });

  test("does not print the usage text", async () => {
    // The old behaviour: unrecognised flag, no command, usage, exit 1.
    const { out } = await run("--version");
    expect(out).not.toContain("Usage");
  });
});

describe("--help", () => {
  test("advertises the flag, so it is discoverable", async () => {
    const { out } = await run("--help");
    expect(out).toContain("--version");
  });
});
