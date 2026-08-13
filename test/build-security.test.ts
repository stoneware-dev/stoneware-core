/**
 * Properties of the build that keep secrets and hostile filenames out of the
 * client bundle.
 *
 * The first one is the important one, and it is an *accidental* property: Bun
 * leaves `process.env.X` as a runtime read for a browser target, so a secret an
 * island touches evaluates to undefined rather than being inlined. Vite and
 * webpack-with-DefinePlugin bake it in. Nothing in the framework asks for this
 * behaviour, which is exactly why it needs a test - a `define` added to the
 * island build later would silently reverse it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIslands } from "../src/build.ts";
import { discoverIslands } from "../src/islands.ts";

// Inside the repo, because the generated entries import "stoneware/client" and
// need the project's module resolution to find it.
const ROOT = join(import.meta.dir, "..", ".build-security");
const ISLANDS = join(ROOT, "islands");

const SECRET = "SUPER_SECRET_VALUE_ABC123";
const DB_URL = "postgres://user:pw@host/db";

let chunkText = "";

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ISLANDS, { recursive: true });

  writeFileSync(
    join(ISLANDS, "Leaky.tsx"),
    `import { signal } from "stoneware/signals";
const n = signal(0);
export default function Leaky() {
  const a = process.env.STONEWARE_CSRF_SECRET;
  const b = Bun.env.DATABASE_URL;
  return <button onClick={() => n.value++}>{String(a).length + String(b).length + n.value}</button>;
}
`,
  );

  process.env.STONEWARE_CSRF_SECRET = SECRET;
  process.env.DATABASE_URL = DB_URL;

  const islands = await discoverIslands(ISLANDS);
  const { staticDir } = await buildIslands({ islands, outDir: join(ROOT, ".out"), dev: false });

  for await (const file of new Bun.Glob("*.js").scan({ cwd: staticDir, absolute: true })) {
    chunkText += await Bun.file(file).text();
  }
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("environment variables and the client bundle", () => {
  test("a secret an island reads is not inlined", () => {
    expect(chunkText).not.toContain(SECRET);
  });

  test("nor is any other environment value it touches", () => {
    expect(chunkText).not.toContain(DB_URL);
  });

  test("the read survives as a runtime expression", () => {
    // Which is what makes it undefined in a browser rather than a leaked
    // string. If this stops being true, the two assertions above are the ones
    // that will start failing.
    expect(/process\.env|Bun\.env/.test(chunkText)).toBe(true);
  });
});

describe("island names the manifest cannot hold", () => {
  test("a name starting with @ is refused", async () => {
    // `islands/@runtime.tsx` produces exactly the key the manifest reserves for
    // the lazy-hydration chunk, so one entry would mean two things.
    const dir = join(ROOT, "reserved");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "@runtime.tsx"), "export default function X() { return <b>x</b>; }\n");

    await expect(discoverIslands(dir)).rejects.toThrow(/reserved/);
  });

  test("an ordinary name is fine", async () => {
    const found = await discoverIslands(ISLANDS);
    expect(found.map((island) => island.name)).toContain("Leaky");
  });
});
