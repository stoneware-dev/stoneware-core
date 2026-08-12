/**
 * The client half of lazy hydration: triggers, and the handoff between a
 * trigger firing and a chunk arriving.
 *
 * happy-dom has no IntersectionObserver, so the tests that need one install a
 * controllable stub. That is the point rather than a workaround - a real
 * observer would make "hydrates when scrolled into view" a timing test.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { h } from "../src/jsx-runtime.ts";

GlobalRegistrator.register();
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { hydrate } = await import("../src/client/hydrate.ts");
const { startLazyHydration } = await import("../src/client/lazy.ts");

function Counter({ start }: { start: number }) {
  return <button type="button">Clicked {start} times</button>;
}

/** Server markup plus a payload, as the document would arrive from Stoneware. */
function serve(
  entries: { name: string; id: string; props: object; on?: string; q?: string }[],
  chunks: Record<string, string> = {},
): void {
  const markup = entries
    .map(
      (entry) =>
        `<button data-stoneware-island="${entry.name}" data-stoneware-id="${entry.id}">server</button>`,
    )
    .join("");

  document.body.innerHTML =
    markup +
    `<script type="application/json" id="stoneware-islands">` +
    JSON.stringify({ islands: entries, chunks }) +
    `</script>`;
}

const text = (id: string) =>
  document.querySelector(`[data-stoneware-id="${id}"]`)?.textContent ?? null;

/* -------------------------------------------------------------------------- */

/** Stub IntersectionObserver, with a handle to fire intersection on demand. */
class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly elements: Element[] = [];
  disconnected = false;

  constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {
    FakeObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.elements.push(element);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  intersect(): void {
    this.callback([{ isIntersecting: true }]);
  }
}

const globals = globalThis as Record<string, unknown>;

beforeEach(() => {
  FakeObserver.instances = [];
});

afterEach(() => {
  delete globals.IntersectionObserver;
  delete globals.matchMedia;
});

describe("client:load is unaffected", () => {
  test("an eager instance mounts as soon as its chunk runs", () => {
    serve([{ name: "Counter", id: "a", props: { start: 3 } }]);

    hydrate("Counter", Counter);
    expect(text("a")).toBe("Clicked 3 times");
  });
});

describe("client:visible", () => {
  test("does not mount before the element is in view", () => {
    globals.IntersectionObserver = FakeObserver;
    serve([{ name: "Counter", id: "b", props: { start: 1 }, on: "visible" }]);

    hydrate("Counter", Counter);
    startLazyHydration();

    expect(text("b")).toBe("server");
    expect(FakeObserver.instances).toHaveLength(1);
  });

  test("mounts once the element intersects", () => {
    globals.IntersectionObserver = FakeObserver;
    serve([{ name: "Counter", id: "c", props: { start: 5 }, on: "visible" }]);

    hydrate("Counter", Counter);
    startLazyHydration();
    FakeObserver.instances[0]!.intersect();

    expect(text("c")).toBe("Clicked 5 times");
  });

  test("stops observing before it swaps the element out", () => {
    // The observed node is about to be replaced; an observer still watching it
    // would keep a detached element alive.
    globals.IntersectionObserver = FakeObserver;
    serve([{ name: "Counter", id: "d", props: { start: 0 }, on: "visible" }]);

    hydrate("Counter", Counter);
    startLazyHydration();
    FakeObserver.instances[0]!.intersect();

    expect(FakeObserver.instances[0]!.disconnected).toBe(true);
  });

  test("hydrates immediately where IntersectionObserver does not exist", () => {
    // Slightly too eager beats a dead button.
    serve([{ name: "Counter", id: "e", props: { start: 9 }, on: "visible" }]);

    hydrate("Counter", Counter);
    startLazyHydration();

    expect(text("e")).toBe("Clicked 9 times");
  });
});

describe("client:media", () => {
  test("mounts at once when the query already matches", () => {
    globals.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    serve([{ name: "Counter", id: "f", props: { start: 2 }, on: "media", q: "(min-width: 1px)" }]);

    hydrate("Counter", Counter);
    startLazyHydration();

    expect(text("f")).toBe("Clicked 2 times");
  });

  test("waits while the query does not match", () => {
    let listener: (() => void) | null = null;
    const list = {
      matches: false,
      addEventListener: (_: string, fn: () => void) => {
        listener = fn;
      },
      removeEventListener() {},
    };
    globals.matchMedia = () => list;

    serve([{ name: "Counter", id: "g", props: { start: 4 }, on: "media", q: "(min-width: 99rem)" }]);
    hydrate("Counter", Counter);
    startLazyHydration();

    expect(text("g")).toBe("server");

    list.matches = true;
    listener!();
    expect(text("g")).toBe("Clicked 4 times");
  });
});

describe("trigger and chunk can arrive in either order", () => {
  test("a trigger that fires before the chunk still mounts when it lands", () => {
    // The realistic case: the reader scrolls to the island while its bundle is
    // still downloading. Nothing queues the entry - hydrate() re-reads the
    // payload and mounts anything already triggered.
    // A name no earlier test registered, so the registry genuinely does not
    // have this island yet.
    globals.IntersectionObserver = FakeObserver;
    serve([{ name: "Later", id: "h", props: { start: 8 }, on: "visible" }], {
      Later: "/_stoneware/Later-xyz.js",
    });

    startLazyHydration();
    FakeObserver.instances[0]!.intersect();
    expect(text("h")).toBe("server");

    // The dynamic import fails here - there is no such file - and logs. That is
    // the state being tested: the chunk arrives by some other means and calls
    // hydrate itself, which must mount the instance that already triggered.
    hydrate("Later", Counter);
    expect(text("h")).toBe("Clicked 8 times");
  });

  test("an instance is never mounted twice", () => {
    globals.IntersectionObserver = FakeObserver;
    serve([{ name: "Counter", id: "i", props: { start: 0 }, on: "visible" }]);

    hydrate("Counter", Counter);
    startLazyHydration();
    FakeObserver.instances[0]!.intersect();
    FakeObserver.instances[0]!.intersect();
    hydrate("Counter", Counter);

    expect(document.querySelectorAll('[data-stoneware-id="i"]')).toHaveLength(1);
  });
});

describe("mixed eager and lazy instances of one island", () => {
  test("each instance follows its own directive", () => {
    globals.IntersectionObserver = FakeObserver;
    serve([
      { name: "Counter", id: "j", props: { start: 1 } },
      { name: "Counter", id: "k", props: { start: 2 }, on: "visible" },
    ]);

    hydrate("Counter", Counter);
    expect(text("j")).toBe("Clicked 1 times");
    expect(text("k")).toBe("server");

    startLazyHydration();
    FakeObserver.instances[0]!.intersect();
    expect(text("k")).toBe("Clicked 2 times");
  });
});
