/**
 * Island hydration.
 *
 * An island bundle calls `hydrate()` once with its own name and component. What
 * happens next depends on each instance's directive: `client:load` instances
 * mount immediately, and anything lazier waits for its trigger (see lazy.ts).
 *
 * Props arrive through a `type="application/json"` payload the server emitted.
 * They are parsed as data, never evaluated - no inline executable script is
 * involved at any point.
 */

import { mountTree } from "./dom.ts";
import { claim, hasTriggered, readPayload, register } from "./registry.ts";
import type { PayloadEntry } from "./registry.ts";
import type { Component } from "../render/types.ts";

/**
 * Activate the instances of one island that are ready for it.
 *
 * Called on load, and again if the chunk is re-imported, so it is written to be
 * safe to repeat: an instance already mounted is skipped.
 */
export function hydrate(name: string, component: Component<any>): void {
  const mount = (entry: PayloadEntry) => mountEntry(entry, component);

  // Read before registering. `readPayload` resets the per-document state when
  // it sees a new payload element, so registering first would put this mounter
  // in place a moment before that reset ran.
  const { islands } = readPayload();
  register(name, mount);

  for (const entry of islands) {
    if (entry.name !== name) continue;

    const strategy = entry.on ?? "load";

    // Eager instances, plus any lazy instance whose trigger already fired while
    // this chunk was still downloading.
    if (strategy === "load" || hasTriggered(entry.id)) mount(entry);
  }
}

/**
 * Mount one island instance, replacing its server-rendered element.
 *
 * The element is replaced rather than patched: with no VDOM there is nothing to
 * reconcile against, and because both sides render the same component with the
 * same props the swap is not visible.
 */
function mountEntry(entry: PayloadEntry, component: Component<any>): void {
  if (!claim(entry.id)) return;

  const target = document.querySelector(`[data-stoneware-id="${CSS.escape(entry.id)}"]`);
  if (!target) {
    console.warn(
      `[stoneware] No server-rendered element found for island "${entry.name}" (${entry.id}).`,
    );
    return;
  }

  try {
    const { fragment } = mountTree(component(entry.props));
    const root = fragment.firstElementChild;
    if (root) {
      // Preserve the markers so repeat hydration (dev reload) still resolves.
      root.setAttribute("data-stoneware-island", entry.name);
      root.setAttribute("data-stoneware-id", entry.id);
    }
    target.replaceWith(fragment);
  } catch (error) {
    console.error(`[stoneware] Island "${entry.name}" failed to hydrate.`, error);
  }
}

export default hydrate;
