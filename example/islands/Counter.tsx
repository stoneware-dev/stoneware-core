/**
 * The canonical island: state in a signal, no hooks, no component instance.
 *
 * The signal is declared at module scope, so every Counter on the page reads
 * and writes the same value. Per-instance state would be a signal created
 * inside the function instead.
 */

import { signal } from "kiln/signals";

const count = signal(0);

export default function Counter() {
  return (
    <button class="counter" type="button" onClick={() => count.value++}>
      Clicked {count} times
    </button>
  );
}
