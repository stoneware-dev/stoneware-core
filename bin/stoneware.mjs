#!/usr/bin/env node
/**
 * Launcher for the `stoneware` CLI.
 *
 * The CLI itself is Bun-only and always will be: `stoneware dev` and `stoneware build` are
 * built on `Bun.serve` and `Bun.build`, which have no Node equivalent worth
 * shimming. But the *entry point* is plain Node JavaScript so that `npx stoneware`
 * reaches a real program instead of a syntax error.
 *
 * Running under Bun, this hands straight over to the TypeScript CLI. Running
 * under Node, it re-executes itself through Bun, or explains how to install Bun
 * if it is not on PATH.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = new URL("../src/cli/index.ts", import.meta.url);

const INSTALL_HINT = `[stoneware] Stoneware runs on Bun, and Bun was not found on your PATH.

  Install it:  https://bun.sh/docs/installation
    macOS/Linux  curl -fsSL https://bun.sh/install | bash
    Windows      powershell -c "irm bun.sh/install.ps1|iex"

Then re-run this command. (\`npx create-stoneware\` works without Bun; running the
dev server and building do not.)`;

if (typeof globalThis.Bun !== "undefined") {
  // Already in Bun: run the real CLI in this process.
  await import(CLI_ENTRY.href);
} else {
  // Probe before running rather than inferring from the exit code afterwards.
  // A missing command is not reported consistently enough to detect: Windows'
  // cmd exits 1 (indistinguishable from a normal failure) and prints its own
  // "'bun' is not recognized" noise, while POSIX shells use 127.
  //
  // `shell: true` throughout, because a `bun` on PATH is often a .cmd or .ps1
  // shim on Windows, which cannot be exec'd directly.
  const probe = spawnSync("bun", ["--version"], { stdio: "ignore", shell: true });
  if (probe.error || probe.status !== 0) {
    console.error(INSTALL_HINT);
    process.exit(1);
  }

  const args = [fileURLToPath(CLI_ENTRY), ...process.argv.slice(2)];
  const result = spawnSync("bun", args, { stdio: "inherit", shell: true });

  if (result.error) {
    console.error(INSTALL_HINT);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}
