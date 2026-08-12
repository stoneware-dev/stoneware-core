import { tally } from "../lib/state.ts";

/** Reads a signal owned by another module; never imports Counter. */
export default function Badge() {
  return (
    <p class="badge">
      <strong>{tally}</strong> total
    </p>
  );
}
