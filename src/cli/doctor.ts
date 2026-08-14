/**
 * `stoneware doctor` - check the things a running server cannot check for you.
 *
 * Deliberately narrow. A missing CSRF secret already stops production from
 * starting with a message that names it, and re-checking that here would be a
 * second place to keep correct for no gain. What belongs in `doctor` is the
 * class of problem that is invisible until it surfaces as something unrelated:
 * a tsconfig that sends JSX to the wrong runtime, a Bun older than the one the
 * framework is built against, a build output directory that is about to be
 * committed.
 *
 * Every check reports what to do, not merely what is wrong. A diagnostic that
 * says "misconfigured" and stops has moved the problem rather than solved it.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfigFile, resolveConfig } from "../config.ts";

export type Severity = "ok" | "warn" | "error";

export interface Finding {
  severity: Severity;
  title: string;
  detail?: string;
}

export interface DoctorResult {
  findings: Finding[];
  errors: number;
  warnings: number;
}

/** The floor declared in `engines`. Below it, behaviour is untested. */
const MINIMUM_BUN = "1.3.0";

export async function doctor(root: string): Promise<DoctorResult> {
  const findings: Finding[] = [];

  findings.push(checkBunVersion());
  findings.push(await checkFrameworkVersion());
  findings.push(...(await checkTsconfig(root)));
  findings.push(await checkConfigFile(root));
  findings.push(checkProjectShape(root));
  findings.push(await checkGitignore(root));

  return {
    findings,
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warn").length,
  };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function checkBunVersion(): Finding {
  if (compareVersions(Bun.version, MINIMUM_BUN) < 0) {
    return {
      severity: "error",
      title: `Bun ${Bun.version} is below the supported floor (${MINIMUM_BUN})`,
      detail: "Run `bun upgrade`. Below this version the framework is untested.",
    };
  }
  return { severity: "ok", title: `Bun ${Bun.version}` };
}

/**
 * Two versions of the same mistake, both fatal to a deploy and neither visible
 * locally - because locally the build directory and the run directory are the
 * same one.
 *
 * Up to 0.1.3, the bundle baked in its build-time absolute root and rescanned
 * `routes/` per request, so a copied build answered 404 for every path.
 *
 * 0.1.4 fixed that but still read `.stoneware/islands.json` through a path
 * computed at runtime. A platform that builds a function by tracing imports
 * cannot see such a path, so the file was left behind and the server threw at
 * boot - the bundle intact, the manifest missing.
 *
 * Worth naming here because both failures look like a mistake in the user's own
 * project rather than in the framework.
 */
async function checkFrameworkVersion(): Promise<Finding> {
  try {
    const manifest = join(import.meta.dir, "..", "..", "package.json");
    const { version } = (await Bun.file(manifest).json()) as { version: string };

    if (compareVersions(version, "0.1.4") < 0) {
      return {
        severity: "warn",
        title: `stoneware ${version} produces builds that only run where they were built`,
        detail:
          "A deploy that copies the build elsewhere - a container, a serverless " +
          "function, a CI artifact - will start and then 404 every path. " +
          "Upgrade to 0.1.5.",
      };
    }

    if (compareVersions(version, "0.1.5") < 0) {
      return {
        severity: "warn",
        title: `stoneware ${version} builds a bundle a function bundler cannot carry whole`,
        detail:
          "The island manifest is read through a runtime path, so a platform that " +
          "traces imports leaves it behind and the server throws at boot with " +
          "'Island manifest not found'. Affects Vercel and anything similar; a VPS " +
          "or container that ships the directory is unaffected. Upgrade to 0.1.5.",
      };
    }

    return { severity: "ok", title: `stoneware ${version}` };
  } catch {
    return { severity: "warn", title: "Could not determine the installed Stoneware version" };
  }
}

/**
 * The check worth having most.
 *
 * JSX compiled against React's runtime does not fail at build time. It fails
 * during a render, as a TypeError about an object, at which point the file being
 * blamed is a template that looks perfectly correct. The renderer carries a
 * paragraph explaining it - this catches it before anyone has to read that.
 */
async function checkTsconfig(root: string): Promise<Finding[]> {
  const path = join(root, "tsconfig.json");
  if (!existsSync(path)) {
    return [
      {
        severity: "warn",
        title: "No tsconfig.json",
        detail:
          'JSX needs "jsx": "react-jsx" and "jsxImportSource": "stoneware", or templates ' +
          "compile against the wrong runtime and fail at render time.",
      },
    ];
  }

  let options: Record<string, unknown>;
  try {
    // Bun's JSON parser accepts comments, which tsconfig files routinely carry.
    const parsed = (await Bun.file(path).json()) as { compilerOptions?: Record<string, unknown> };
    options = parsed.compilerOptions ?? {};
  } catch {
    return [{ severity: "error", title: "tsconfig.json could not be parsed" }];
  }

  const findings: Finding[] = [];

  if (options.jsx !== "react-jsx") {
    findings.push({
      severity: "error",
      title: `tsconfig compilerOptions.jsx is ${JSON.stringify(options.jsx ?? null)}, expected "react-jsx"`,
      detail: "Templates will not compile to the framework's JSX runtime.",
    });
  }

  if (options.jsxImportSource !== "stoneware") {
    findings.push({
      severity: "error",
      title: `tsconfig compilerOptions.jsxImportSource is ${JSON.stringify(options.jsxImportSource ?? null)}, expected "stoneware"`,
      detail:
        "JSX will compile against React's runtime. This does not fail at build time - it " +
        "fails mid-render as a TypeError about an object, pointing at a template that is fine.",
    });
  }

  if (findings.length === 0) findings.push({ severity: "ok", title: "tsconfig JSX settings" });
  return findings;
}

async function checkConfigFile(root: string): Promise<Finding> {
  const names = ["stoneware.config.ts", "stoneware.config.js"];
  const present = names.find((name) => existsSync(join(root, name)));

  if (!present) {
    return {
      severity: "ok",
      title: "No stoneware.config.ts - defaults apply",
      detail: "Every security default is safe with no config at all.",
    };
  }

  try {
    const config = await loadConfigFile(root);
    const resolved = resolveConfig({ ...config, root }, true);

    if (resolved.csp === false) {
      return {
        severity: "warn",
        title: `${present} sets csp: false`,
        detail:
          "No Content-Security-Policy will be sent. This is a supported choice, but it " +
          "removes the defence that makes script-src 'self' meaningful.",
      };
    }

    if (resolved.followSymlinks) {
      return {
        severity: "warn",
        title: `${present} sets followSymlinks: true`,
        detail:
          "A symlink written into public/ will serve whatever it points at, anywhere on disk.",
      };
    }

    if (resolved.trustProxy === true) {
      return {
        severity: "warn",
        title: `${present} sets trustProxy: true`,
        detail:
          "X-Forwarded-Host is trusted. Anyone who can reach the app directly can forge it " +
          'and poison every absolute URL it emits. Prefer "proto" unless you need the host.',
      };
    }

    return { severity: "ok", title: `${present} loads and resolves` };
  } catch (error) {
    return {
      severity: "error",
      title: `${present} failed to load`,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function checkProjectShape(root: string): Finding {
  const routes = join(root, "routes");
  if (!existsSync(routes)) {
    return {
      severity: "error",
      title: "No routes/ directory",
      detail: "The server will not start. Create routes/ with at least an index.tsx.",
    };
  }

  const hasIndex = ["index.tsx", "index.jsx", "index.ts", "index.js"].some((name) =>
    existsSync(join(routes, name)),
  );

  if (!hasIndex) {
    return {
      severity: "warn",
      title: "routes/ has no index route",
      detail: "Nothing answers `/`.",
    };
  }

  return { severity: "ok", title: "routes/ with an index route" };
}

async function checkGitignore(root: string): Promise<Finding> {
  const path = join(root, ".gitignore");
  if (!existsSync(path)) {
    return {
      severity: "warn",
      title: "No .gitignore",
      detail: "Build output in .stoneware/ and any .env file will be committed.",
    };
  }

  const text = await Bun.file(path).text();
  const missing = [".stoneware", ".env"].filter((entry) => !text.includes(entry));

  if (missing.length > 0) {
    return {
      severity: "warn",
      title: `.gitignore does not cover ${missing.join(" or ")}`,
      detail:
        missing.includes(".env")
          ? "A committed .env carries STONEWARE_CSRF_SECRET into the repository."
          : "Build output will be committed.",
    };
  }

  return { severity: "ok", title: ".gitignore covers build output and .env" };
}

const MARK: Record<Severity, string> = { ok: "ok  ", warn: "warn", error: "FAIL" };

export function describeDoctor(result: DoctorResult): string {
  const lines = result.findings.flatMap((finding) => {
    const head = `  ${MARK[finding.severity]}  ${finding.title}`;
    return finding.detail ? [head, `        ${finding.detail}`] : [head];
  });

  lines.push("");
  lines.push(
    result.errors === 0 && result.warnings === 0
      ? "  Nothing to fix."
      : `  ${result.errors} error(s), ${result.warnings} warning(s).`,
  );

  return lines.join("\n");
}
