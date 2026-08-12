#!/usr/bin/env bun
/**
 * Entry point for the `stoneware` CLI.
 *
 * The shebang names Bun rather than Node deliberately. `stoneware dev` and
 * `stoneware build` are built on `Bun.serve` and `Bun.build`, so there is no
 * Node code path that does real work — and a Bun-only environment may have no
 * `node` binary at all. Vercel's Bun build image is exactly that: a
 * `#!/usr/bin/env node` shebang there fails with
 * `env: 'node': No such file or directory` before the CLI can even explain
 * itself.
 *
 * `create-stoneware` keeps a Node shebang, because that one has to run *before*
 * Bun is installed. This one never does.
 */

import "../src/cli/index.ts";
