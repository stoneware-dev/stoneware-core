/**
 * Client runtime tests: DOM construction and signal bindings (milestones 2-3).
 *
 * happy-dom is registered before the client modules are imported, so they see a
 * real `document` exactly as they would in a browser.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { computed, signal } from "@preact/signals-core";
import { h } from "../src/jsx-runtime.ts";

// `bun test` runs every file in one process, and registering happy-dom replaces
// globals including Response and Blob. Left in place, it breaks Bun.file()
// response bodies in whichever test file happens to run next.
GlobalRegistrator.register();
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const { mountTree } = await import("../src/client/dom.ts");
const { hydrate } = await import("../src/client/hydrate.ts");

function mountInto(container: Element, tree: Parameters<typeof mountTree>[0]) {
  const { fragment, dispose } = mountTree(tree);
  container.appendChild(fragment);
  return dispose;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("DOM construction", () => {
  test("builds elements, attributes, and text", () => {
    const root = document.createElement("div");
    mountInto(root, <p class="lead" data-n="3">hello</p>);
    expect(root.innerHTML).toBe(`<p class="lead" data-n="3">hello</p>`);
  });

  test("omits false attributes and bare-renders true ones", () => {
    const root = document.createElement("div");
    mountInto(root, <input required={true} readonly={false} />);
    expect(root.innerHTML).toBe(`<input required="">`);
  });

  test("assigns form state as a property, not an attribute", () => {
    const root = document.createElement("div");
    mountInto(root, <input value="typed" />);
    const input = root.querySelector("input")!;
    expect((input as HTMLInputElement).value).toBe("typed");
  });

  test("renders fragments and arrays flat", () => {
    const root = document.createElement("div");
    mountInto(root, <><b>a</b>{[<i>b</i>, <u>c</u>]}</>);
    expect(root.innerHTML).toBe("<b>a</b><i>b</i><u>c</u>");
  });
});

describe("signal bindings", () => {
  test("a signal child updates without rebuilding the tree", () => {
    const count = signal(0);
    const root = document.createElement("div");
    mountInto(root, <span>Count: {count}</span>);

    const span = root.querySelector("span")!;
    expect(span.textContent).toBe("Count: 0");

    count.value = 5;
    expect(span.textContent).toBe("Count: 5");
  });

  test("text-to-text updates mutate the existing node rather than replacing it", () => {
    const label = signal("a");
    const root = document.createElement("div");
    mountInto(root, <span>{label}</span>);

    const before = root.querySelector("span")!.firstChild;
    label.value = "b";
    const after = root.querySelector("span")!.firstChild;

    expect(after).toBe(before);
    expect(after!.textContent).toBe("b");
  });

  test("a signal attribute updates in place", () => {
    const tone = signal("idle");
    const root = document.createElement("div");
    mountInto(root, <p class={tone}>x</p>);

    expect(root.querySelector("p")!.getAttribute("class")).toBe("idle");
    tone.value = "error";
    expect(root.querySelector("p")!.getAttribute("class")).toBe("error");
  });

  test("a computed signal drives a derived attribute", () => {
    const status = signal<"idle" | "sending">("idle");
    const root = document.createElement("div");
    mountInto(root, <button disabled={computed(() => status.value === "sending")}>go</button>);

    const button = root.querySelector("button")!;
    expect(button.hasAttribute("disabled")).toBe(false);
    status.value = "sending";
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  test("a signal holding markup replaces its subtree", () => {
    const view = signal(<em>first</em>);
    const root = document.createElement("div");
    mountInto(root, <div>{view}</div>);

    expect(root.querySelector("div")!.innerHTML).toContain("<em>first</em>");
    view.value = <strong>second</strong>;
    const inner = root.querySelector("div")!.innerHTML;
    expect(inner).toContain("<strong>second</strong>");
    expect(inner).not.toContain("<em>");
  });

  test("event handlers are attached and drive signal updates", () => {
    const count = signal(0);
    const root = document.createElement("div");
    document.body.appendChild(root);
    mountInto(root, <button onClick={() => count.value++}>Clicked {count} times</button>);

    const button = root.querySelector("button")!;
    button.click();
    button.click();

    expect(count.value).toBe(2);
    expect(button.textContent).toBe("Clicked 2 times");
  });

  test("dispose() detaches the subscriptions", () => {
    const count = signal(0);
    const root = document.createElement("div");
    const dispose = mountInto(root, <span>{count}</span>);
    const span = root.querySelector("span")!;

    count.value = 1;
    expect(span.textContent).toBe("1");

    dispose();
    count.value = 2;
    expect(span.textContent).toBe("1");
  });

  test("two independent mounts share one exported signal", () => {
    // The cross-island pattern from CLAUDE.md §8: separate trees, one module.
    const shared = signal(1284);
    const a = document.createElement("div");
    const b = document.createElement("div");
    mountInto(a, <p>{shared}</p>);
    mountInto(b, <strong>{shared}</strong>);

    shared.value = 1285;

    expect(a.textContent).toBe("1285");
    expect(b.textContent).toBe("1285");
  });
});

describe("hydration", () => {
  function Counter({ start }: { start: number }) {
    const count = signal(start);
    return (
      <button type="button" onClick={() => count.value++}>
        Clicked {count} times
      </button>
    );
  }

  test("replaces server markup and keeps the element interactive", () => {
    document.body.innerHTML =
      `<button type="button" data-sinter-island="Counter" data-sinter-id="sinter-0">Clicked 3 times</button>` +
      `<script type="application/json" id="sinter-islands">` +
      `[{"name":"Counter","id":"sinter-0","props":{"start":3}}]</script>`;

    hydrate("Counter", Counter);

    const button = document.querySelector("button")!;
    expect(button.textContent).toBe("Clicked 3 times");

    button.click();
    expect(button.textContent).toBe("Clicked 4 times");
  });

  test("preserves the markers so the element stays addressable", () => {
    document.body.innerHTML =
      `<button data-sinter-island="Counter" data-sinter-id="sinter-0">Clicked 0 times</button>` +
      `<script type="application/json" id="sinter-islands">` +
      `[{"name":"Counter","id":"sinter-0","props":{"start":0}}]</script>`;

    hydrate("Counter", Counter);

    const button = document.querySelector('[data-sinter-id="sinter-0"]')!;
    expect(button.getAttribute("data-sinter-island")).toBe("Counter");
  });

  test("hydrates every instance of the same island", () => {
    document.body.innerHTML =
      `<button data-sinter-island="Counter" data-sinter-id="sinter-0">Clicked 0 times</button>` +
      `<button data-sinter-island="Counter" data-sinter-id="sinter-1">Clicked 10 times</button>` +
      `<script type="application/json" id="sinter-islands">` +
      `[{"name":"Counter","id":"sinter-0","props":{"start":0}},` +
      `{"name":"Counter","id":"sinter-1","props":{"start":10}}]</script>`;

    hydrate("Counter", Counter);

    const buttons = document.querySelectorAll("button");
    expect(buttons.length).toBe(2);

    (buttons[1] as HTMLElement).click();
    expect(buttons[0]!.textContent).toBe("Clicked 0 times");
    expect(buttons[1]!.textContent).toBe("Clicked 11 times");
  });
});
