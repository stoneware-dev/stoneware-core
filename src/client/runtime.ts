/**
 * The chunk a page loads when it has any lazily-hydrated island.
 *
 * Deliberately tiny and deliberately separate: a page whose islands are all
 * `client:visible` downloads this and nothing else until the reader scrolls.
 * Folding it into an island bundle would defeat that, and folding it into the
 * shared chunk would not help, because with no eager island nothing pulls the
 * shared chunk in either.
 */

import { startLazyHydration } from "./lazy.ts";

startLazyHydration();
