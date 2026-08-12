/**
 * State shared between islands.
 *
 * This is the whole mechanism: export a signal from a module and import it in
 * more than one island (CLAUDE.md §8). The islands are separate bundles, but the
 * bundler hoists this module into the shared chunk, so both sides observe the
 * same signal instance.
 */

import { signal } from "kiln/signals";

/** Bumped by the newsletter island, displayed by the badge island. */
export const subscriberCount = signal(1284);
