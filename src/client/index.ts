/**
 * Browser entry point for Stoneware's client runtime.
 *
 * Generated island entries import from here. Keeping the surface this small
 * matters: everything reachable from this module ends up in the shared client
 * chunk every island page downloads.
 */

export { hydrate } from "./hydrate.ts";
export { mountTree } from "./dom.ts";
export type { Disposer } from "./dom.ts";
export { signal, computed, effect, batch, untracked } from "../signals.ts";
