import { signal } from "stoneware/signals";

/** Imported by two islands, to prove the bundler hoists it into a shared chunk. */
export const tally = signal(7);
