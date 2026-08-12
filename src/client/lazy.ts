/**
 * Deferred hydration triggers (`client:visible`, `client:idle`, `client:media`).
 *
 * This module is the whole point of lazy islands: it is small, it is the only
 * thing a page of lazy islands downloads up front, and it decides when the
 * real chunks are fetched.
 *
 * Every trigger degrades to hydrating immediately when the API behind it is
 * missing. A browser without `IntersectionObserver` should get a working page
 * slightly sooner than it wanted, never a dead button.
 */

import { activate, hasTriggered, markTriggered, readPayload } from "./registry.ts";
import type { PayloadEntry } from "./registry.ts";

/** Hydrate slightly before the element scrolls into view, not as it lands. */
const VISIBLE_MARGIN = "200px";

/** Cap on how long `client:idle` waits for a quiet moment that may never come. */
const IDLE_TIMEOUT = 2000;

export function startLazyHydration(): void {
  const { islands } = readPayload();

  for (const entry of islands) {
    const strategy = entry.on ?? "load";
    if (strategy === "load") continue;
    if (hasTriggered(entry.id)) continue;

    const element = document.querySelector(`[data-stoneware-id="${CSS.escape(entry.id)}"]`);
    if (!element) {
      // Nothing to observe. Hydrating anyway would be worse than doing nothing:
      // `activate` warns about the missing element and moves on.
      continue;
    }

    arm(entry, element, strategy);
  }
}

function arm(entry: PayloadEntry, element: Element, strategy: string): void {
  const fire = () => {
    if (hasTriggered(entry.id)) return;
    markTriggered(entry.id);
    activate(entry);
  };

  switch (strategy) {
    case "visible":
      onVisible(element, fire);
      return;
    case "idle":
      onIdle(fire);
      return;
    case "media":
      onMedia(entry.q, fire);
      return;
    default:
      // An unknown directive reached the client, which means the server let it
      // through. Hydrate rather than leave the island inert.
      console.warn(`[stoneware] Unknown hydration strategy "${strategy}"; hydrating immediately.`);
      fire();
  }
}

function onVisible(element: Element, fire: () => void): void {
  if (typeof IntersectionObserver === "undefined") {
    fire();
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const record of entries) {
        if (!record.isIntersecting) continue;
        // Disconnect before mounting: mounting replaces the observed element,
        // and an observer left watching a detached node keeps it alive.
        observer.disconnect();
        fire();
        return;
      }
    },
    { rootMargin: VISIBLE_MARGIN },
  );

  observer.observe(element);
}

function onIdle(fire: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: typeof requestIdleCallback })
    .requestIdleCallback;

  if (typeof idle === "function") {
    idle(() => fire(), { timeout: IDLE_TIMEOUT });
    return;
  }

  // Safari had no requestIdleCallback for years. A timeout is a poor imitation,
  // but it keeps the ordering property that matters: after first paint.
  setTimeout(fire, 1);
}

function onMedia(query: string | undefined, fire: () => void): void {
  if (!query || typeof matchMedia !== "function") {
    fire();
    return;
  }

  const list = matchMedia(query);
  if (list.matches) {
    fire();
    return;
  }

  const onChange = () => {
    if (!list.matches) return;
    list.removeEventListener("change", onChange);
    fire();
  };
  list.addEventListener("change", onChange);
}
