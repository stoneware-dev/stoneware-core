/**
 * The install widget: pick a package runner, copy the command.
 *
 * It documents the one place Stoneware is not Bun-only. Scaffolding runs on plain
 * Node so `npx create-stoneware` works before Bun is installed; everything after
 * that — dev server, build — needs Bun.
 */

import { computed, signal } from "stoneware/signals";

type Runner = "bunx" | "npx";

const runner = signal<Runner>("bunx");
const copied = signal(false);

const command = computed(() => `${runner.value} create-stoneware my-site`);
const copyLabel = computed(() => (copied.value ? "Copied" : "Copy"));

const RUNNERS: Runner[] = ["bunx", "npx"];

let resetTimer: ReturnType<typeof setTimeout> | undefined;

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(command.value);
    copied.value = true;
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => (copied.value = false), 1600);
  } catch {
    // Clipboard access can be denied; the command stays selectable either way.
    copied.value = false;
  }
}

export default function InstallCommand() {
  return (
    <div class="install">
      <div class="install__tabs" role="tablist" aria-label="Package runner">
        {RUNNERS.map((name) => (
          <button
            type="button"
            role="tab"
            class="install__tab"
            // ARIA wants the literal string, and the stylesheet keys off it.
            // A boolean would render as a bare attribute or vanish entirely.
            aria-selected={computed(() => (runner.value === name ? "true" : "false"))}
            onClick={() => (runner.value = name)}
          >
            {name}
          </button>
        ))}
      </div>

      <div class="install__body">
        <p class="install__cmd">{command}</p>
        <button type="button" class="install__copy" onClick={copy}>
          {copyLabel}
        </button>
      </div>

      <p class="install__note">
        Both runners scaffold the project. Stoneware itself runs on Bun: the generated app needs it for{" "}
        <code>stoneware dev</code> and <code>stoneware build</code>.
      </p>
    </div>
  );
}
