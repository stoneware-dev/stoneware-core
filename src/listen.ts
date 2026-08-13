/**
 * Starting a server when the port might be busy.
 *
 * In development, a port already in use is usually another copy of the same
 * project - a previous run that did not exit, or a second checkout. Refusing to
 * start is the least useful response: the developer wants a server, not a
 * lecture about which port it is on. So dev walks up to the next free port and
 * says where it landed.
 *
 * Production does the opposite. A platform routes traffic to the port it
 * assigned; quietly binding a different one produces a service that looks
 * healthy in its own logs while every request from outside fails. There the
 * error is the correct outcome.
 */

import type { WebSocketHandler } from "bun";

/** How many ports to try before giving up, starting from the requested one. */
const MAX_ATTEMPTS = 10;

export interface ListenOptions<T = undefined> {
  port: number;
  hostname: string;
  /**
   * `undefined` is a valid answer: it is how a handler signals that it has
   * already taken the socket over, which is what `server.upgrade()` does for
   * the dev server's live-reload channel.
   */
  fetch: (
    request: Request,
    server: Bun.Server<T>,
  ) => Response | undefined | Promise<Response | undefined>;
  websocket?: WebSocketHandler<T>;
  /** Walk to the next free port when one is taken. Development only. */
  allowPortFallback?: boolean;
}

export function listen<T = undefined>(options: ListenOptions<T>): Bun.Server<T> {
  const { allowPortFallback = false, ...serveOptions } = options;
  const attempts = allowPortFallback ? MAX_ATTEMPTS : 1;

  for (let offset = 0; offset < attempts; offset++) {
    const port = options.port + offset;

    try {
      // `as never` because Bun.serve's overloads split on the presence of
      // `websocket`, and this passes it through generically.
      return Bun.serve({ ...serveOptions, port } as never) as Bun.Server<T>;
    } catch (error) {
      if (!isAddressInUse(error) || offset === attempts - 1) throw error;
      console.warn(`[stoneware] port ${port} is in use, trying ${port + 1}`);
    }
  }

  // Unreachable: the loop either returns or throws on its final attempt.
  throw new Error("Unable to start a server");
}

/**
 * Is this the "port already taken" error?
 *
 * Bun surfaces it as an `EADDRINUSE` code on some platforms and only in the
 * message on others, so both are checked rather than trusting one.
 */
function isAddressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "EADDRINUSE") return true;
  return typeof message === "string" && message.includes("EADDRINUSE");
}
