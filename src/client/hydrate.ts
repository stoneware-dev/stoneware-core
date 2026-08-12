/**
 * Island hydration.
 *
 * v0.1 hydrates eagerly: every island on the page activates as soon as its
 * bundle loads (CLAUDE.md §8). Lazy `client:visible`-style directives are a
 * fast-follow, not launch-blocking.
 *
 * Props arrive through a `type="application/json"` payload the server emitted.
 * They are parsed as data, never evaluated - no inline executable script is
 * involved at any point.
 */

import { mountTree } from "./dom.ts";
import type { Component, Props } from "../types.ts";

interface IslandPayloadEntry {
  name: string;
  id: string;
  props: Props;
}

const PAYLOAD_ELEMENT_ID = "stoneware-islands";

// Parsing once per page is the point, but the cache is keyed on the payload
// element itself rather than a plain flag: if the document is replaced - a dev
// live-reload, a test, a future client-side navigation - the stale entry is
// discarded instead of silently hydrating against props that no longer exist.
let cachedElement: HTMLElement | null = null;
let cachedPayload: IslandPayloadEntry[] = [];

function readPayload(): IslandPayloadEntry[] {
  const element = document.getElementById(PAYLOAD_ELEMENT_ID);
  if (element === cachedElement) return cachedPayload;

  cachedElement = element;
  cachedPayload = [];

  if (!element?.textContent) return cachedPayload;

  try {
    const parsed = JSON.parse(element.textContent);
    if (Array.isArray(parsed)) cachedPayload = parsed;
  } catch (error) {
    console.error("[stoneware] Island payload is not valid JSON; islands will not hydrate.", error);
  }
  return cachedPayload;
}

/**
 * Activate every occurrence of one island on the page.
 *
 * Each island bundle calls this once with its own name and component. The
 * server-rendered element is replaced by the client-built tree rather than
 * patched: with no VDOM there is nothing to reconcile against, and because both
 * sides render the same component with the same props the swap is not visible.
 */
export function hydrate(name: string, component: Component<any>): void {
  for (const entry of readPayload()) {
    if (entry.name !== name) continue;

    const target = document.querySelector(`[data-stoneware-id="${CSS.escape(entry.id)}"]`);
    if (!target) {
      console.warn(`[stoneware] No server-rendered element found for island "${name}" (${entry.id}).`);
      continue;
    }

    try {
      const { fragment } = mountTree(component(entry.props));
      const root = fragment.firstElementChild;
      if (root) {
        // Preserve the markers so repeat hydration (dev reload) still resolves.
        root.setAttribute("data-stoneware-island", name);
        root.setAttribute("data-stoneware-id", entry.id);
      }
      target.replaceWith(fragment);
    } catch (error) {
      console.error(`[stoneware] Island "${name}" failed to hydrate.`, error);
    }
  }
}

export default hydrate;
