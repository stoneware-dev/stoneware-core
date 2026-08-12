/**
 * The canonical island: state in a signal, no hooks, no component instance.
 *
 * This button was server-rendered as static HTML with the count already at
 * zero, then hydrated. Clicking updates exactly one text node — the tree is
 * never re-run and nothing is diffed.
 */

import { signal } from "stoneware/signals";

const count = signal(0);

export default function LiveCounter() {
  return (
    <button type="button" class="counter" onClick={() => count.value++}>
      fired <b>{count}</b> times
    </button>
  );
}
