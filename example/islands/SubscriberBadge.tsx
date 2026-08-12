/**
 * Reads a signal it does not own.
 *
 * This island and Newsletter are compiled into separate bundles and never
 * import each other — they share state only through lib/state.ts. When the
 * newsletter form succeeds, this number updates without either island knowing
 * the other exists.
 */

import { subscriberCount } from "../lib/state.ts";

export default function SubscriberBadge() {
  return (
    <p class="badge">
      <strong>{subscriberCount}</strong> readers subscribed
    </p>
  );
}
