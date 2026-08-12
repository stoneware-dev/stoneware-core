/**
 * Reactivity, re-exported from `@preact/signals-core`.
 *
 * This module is intentionally a thin pass-through. Stoneware does not implement a
 * reactive engine - that is the single most important scope boundary in the
 * project (CLAUDE.md §2.3). Preact Signals already provides a correct,
 * battle-tested dependency graph with glitch-free batching, and re-deriving it
 * would be the fastest way to turn a small framework into a large one.
 *
 * The indirection exists so app code imports `stoneware/signals` rather than the
 * upstream package directly, which keeps the dependency swappable later without
 * a breaking change to every island.
 */

export {
  signal,
  computed,
  effect,
  batch,
  untracked,
  Signal,
} from "@preact/signals-core";

export type { ReadonlySignal } from "@preact/signals-core";
