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

/**
 * Loopback addresses to ask before binding.
 *
 * Both, not one. "localhost" resolves to ::1 first on Windows and to 127.0.0.1
 * on most Linux setups, so probing a single family finds a neighbour on that
 * family only - which is exactly the case that went unnoticed.
 */
const PROBE_ADDRESSES = ["127.0.0.1", "::1"];

/** Loopback refuses instantly; this only guards a probe that hangs instead. */
const PROBE_TIMEOUT_MS = 250;

/**
 * Is something already answering on this port?
 *
 * A successful bind does not mean the port was free. A loopback bind and an
 * all-interfaces bind are different sockets, so two servers can each hold :3000
 * without either seeing an error - and requests then go to whichever one the
 * client's IPv4/IPv6 preference happens to pick. That is worse than a clean
 * failure, because both processes report success.
 *
 * Asking whether anything *answers* catches it. Asking whether bind failed
 * cannot: nothing failed.
 */
async function isPortAnswering(port: number): Promise<boolean> {
  for (const hostname of PROBE_ADDRESSES) {
    if (await canConnect(hostname, port)) return true;
  }
  return false;
}

async function canConnect(hostname: string, port: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });

  const attempt = (async () => {
    try {
      const socket = await Bun.connect({
        hostname,
        port,
        // Required by the API, and there is nothing to do with the connection:
        // that it opened at all is the whole answer.
        socket: { data() {}, error() {}, close() {} },
      });
      socket.end();
      return true;
    } catch {
      // Refused, unreachable, or no such address family - all mean "free".
      return false;
    }
  })();

  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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

export async function listen<T = undefined>(options: ListenOptions<T>): Promise<Bun.Server<T>> {
  const { allowPortFallback = false, ...serveOptions } = options;
  const attempts = allowPortFallback ? MAX_ATTEMPTS : 1;
  const last = options.port + attempts - 1;

  for (let offset = 0; offset < attempts; offset++) {
    const port = options.port + offset;

    // Only in development, and only as a reason to move. Production never
    // probes: it must bind the port it was given or fail saying so, and a probe
    // there could only turn a clear error into a quieter one.
    if (allowPortFallback && (await isPortAnswering(port))) {
      console.warn(`[stoneware] something is already serving on port ${port}, trying ${port + 1}`);
      continue;
    }

    try {
      // `as never` because Bun.serve's overloads split on the presence of
      // `websocket`, and this passes it through generically.
      return Bun.serve({ ...serveOptions, port } as never) as Bun.Server<T>;
    } catch (error) {
      if (!isAddressInUse(error) || offset === attempts - 1) throw error;
      console.warn(`[stoneware] port ${port} is in use, trying ${port + 1}`);
    }
  }

  // Reached when every candidate was already answering, so no bind was ever
  // attempted and there is no underlying error to surface.
  throw new Error(
    `No free port between ${options.port} and ${last}: something is already ` +
      `serving on each of them. Pass --port to pick another.`,
  );
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
