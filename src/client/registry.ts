/**
 * The bookkeeping both hydration paths share.
 *
 * Two things can happen in either order: an island's chunk arrives and
 * registers its component, or an instance's trigger fires and asks to be
 * mounted. This module holds the state that lets them meet in the middle, so
 * neither path has to know whether it ran first.
 *
 * It deliberately imports nothing that touches the DOM builder or signals. A
 * page whose islands are all lazy loads this and lazy.ts and nothing else -
 * pulling in `mountTree` here would drag the entire ~4 kB runtime along with
 * it and there would be no saving left to speak of.
 */

import type { Props } from "../render/types.ts";

/** How an island instance decides when to activate. */
export type Strategy = "load" | "visible" | "idle" | "media";

export interface PayloadEntry {
  name: string;
  id: string;
  props: Props;
  /** Absent means `load` - the common case, kept out of the HTML. */
  on?: Strategy;
  /** Media query, for `client:media` only. */
  q?: string;
}

export interface Payload {
  islands: PayloadEntry[];
  /**
   * Chunk URL per island that has no eagerly-loaded instance on this page.
   * An island with even one `client:load` instance already has a module script,
   * so its URL would be dead weight here.
   */
  chunks: Record<string, string>;
}

const PAYLOAD_ELEMENT_ID = "stoneware-islands";
const EMPTY: Payload = { islands: [], chunks: {} };

// Parsing once per page is the point, but the cache is keyed on the payload
// element itself rather than a plain flag: if the document is replaced - a dev
// live-reload, a test, a future client-side navigation - the stale entry is
// discarded instead of silently hydrating against props that no longer exist.
let cachedElement: HTMLElement | null = null;
let cachedPayload: Payload = EMPTY;

export function readPayload(): Payload {
  const element = document.getElementById(PAYLOAD_ELEMENT_ID);
  if (element === cachedElement) return cachedPayload;

  cachedElement = element;
  cachedPayload = EMPTY;

  if (!element?.textContent) return cachedPayload;

  try {
    const parsed = JSON.parse(element.textContent) as Partial<Payload>;
    if (Array.isArray(parsed?.islands)) {
      cachedPayload = { islands: parsed.islands, chunks: parsed.chunks ?? {} };
      // A new document invalidates everything keyed to instance ids, which
      // belong to the render that produced them. `mounters` is deliberately
      // left alone: it is keyed by island name, a re-imported chunk overwrites
      // its own entry anyway, and clearing it here would silently undo a
      // `register()` that happened moments earlier in the same call.
      mounted.clear();
      requested.clear();
      triggered.clear();
    } else {
      // Valid JSON in a shape this runtime does not recognise - almost always a
      // server and a client runtime from different versions. Saying so beats
      // leaving every island on the page inert with no explanation.
      console.error(
        "[stoneware] Island payload has an unexpected shape; islands will not hydrate. " +
          "This usually means the server and client runtime are different versions.",
      );
    }
  } catch (error) {
    console.error("[stoneware] Island payload is not valid JSON; islands will not hydrate.", error);
  }

  return cachedPayload;
}

/**
 * Island name -> the function that mounts one of its instances.
 *
 * A closure rather than the component itself, so this module never needs to
 * know how mounting works and never has to import the code that does it.
 */
const mounters = new Map<string, (entry: PayloadEntry) => void>();

/** Instance ids already mounted, so a second trigger is a no-op. */
const mounted = new Set<string>();

/** Island names whose chunk import is already in flight. */
const requested = new Set<string>();

export function register(name: string, mount: (entry: PayloadEntry) => void): void {
  mounters.set(name, mount);
}

/** True if this instance had not already been mounted, claiming it if so. */
export function claim(id: string): boolean {
  if (mounted.has(id)) return false;
  mounted.add(id);
  return true;
}

/**
 * A trigger has fired for this instance: mount it if its chunk is here,
 * otherwise fetch the chunk and let it mount on arrival.
 *
 * Entries waiting on a chunk are not tracked in a queue. The chunk calls
 * `hydrate()`, which re-reads the payload and mounts everything already
 * triggered - so the payload itself is the queue, and it cannot go stale.
 */
export function activate(entry: PayloadEntry): void {
  triggered.add(entry.id);

  const mount = mounters.get(entry.name);
  if (mount) {
    mount(entry);
    return;
  }

  const src = cachedPayload.chunks[entry.name];
  if (!src) {
    // No chunk URL and no component: the island has an eagerly-loaded script
    // that has not run yet. `hydrate()` will flush this entry when it does.
    return;
  }
  if (requested.has(entry.name)) return;
  requested.add(entry.name);

  // A same-origin dynamic import, which `script-src 'self'` permits - no inline
  // script and no nonce plumbing.
  import(/* webpackIgnore: true */ src).catch((error: unknown) => {
    requested.delete(entry.name);
    console.error(`[stoneware] Failed to load island "${entry.name}" from ${src}.`, error);
  });
}

/** Instance ids whose trigger has fired, mounted or not. */
const triggered = new Set<string>();

export function hasTriggered(id: string): boolean {
  return triggered.has(id);
}

export function markTriggered(id: string): void {
  triggered.add(id);
}
