/** A route that always throws, so the 500 path has something to catch. */
export default function Boom() {
  throw new Error("boom: fixture route failed on purpose");
}
