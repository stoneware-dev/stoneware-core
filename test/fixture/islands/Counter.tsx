import { signal } from "stoneware/signals";
import { tally } from "../lib/state.ts";

const count = signal(0);

export default function Counter() {
  return (
    <button
      type="button"
      class="counter"
      onClick={() => {
        count.value++;
        tally.value++;
      }}
    >
      Clicked {count} times
    </button>
  );
}
