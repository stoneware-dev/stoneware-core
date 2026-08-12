#!/usr/bin/env bun
/**
 * Link the repo root into example/node_modules for local development.
 *
 * example/ is a standalone package that depends on the published `stoneware`,
 * so that it can deploy on its own (Vercel builds with it as the root
 * directory). Locally we want the opposite: the docs site should exercise the
 * working tree, not the last release.
 *
 * A tsconfig `paths` mapping looked like the obvious answer and is wrong — a
 * deploy clones the whole repository and only changes directory, so ../src
 * exists there too and wins over node_modules, dragging in framework source
 * whose own dependencies are not installed. Linking keeps the resolution
 * mechanism identical in both places; only the link target differs.
 */

import { mkdir, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// This file lives in scripts/, so the package root is one level up.
const root = resolve(import.meta.dir, "..");
const target = join(root, "example", "node_modules", "stoneware");

await mkdir(dirname(target), { recursive: true });
if (existsSync(target)) await rm(target, { recursive: true, force: true });

// "junction" is the only symlink type Windows allows without elevation.
await symlink(root, target, process.platform === "win32" ? "junction" : "dir");

console.log(`[stoneware] linked example/node_modules/stoneware -> ${root}`);
