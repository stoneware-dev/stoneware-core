/**
 * Request observability.
 *
 * One hook, called once per request at the same single exit point the security
 * headers are applied at. Anything that reaches a client passes through it, so
 * a new code path cannot quietly stop being measured.
 *
 * The reason this is in the framework rather than left to `_middleware.ts` is
 * `route`: the matched *pattern*, `/blog/[slug]`, not the path that was
 * requested. That is the label you group by - one row per route instead of one
 * row per slug - and middleware runs before matching, so it cannot know it.
 * `kind` is the same argument: only the pipeline knows whether a 404 came from
 * an unmatched path or from a page that called `notFound()`, and only it can
 * tell a CSRF rejection apart from an application error.
 *
 * Like middleware, an observer cannot alter the response. It is handed a
 * finished one and its return value is discarded. A hook that could rewrite what
 * has already been assembled could remove the headers assembled onto it, and
 * "you can see everything, you can change nothing" is a boundary worth keeping
 * simple enough to state in one sentence.
 */

/** What answered the request. */
export type RequestKind =
  /** A route that rendered HTML. Includes a page that called `notFound()`. */
  | "page"
  /** An HTTP method handler under `routes/`. */
  | "action"
  /** A file from `public/`, or a built island chunk. */
  | "asset"
  /** No route matched the path. */
  | "not-found"
  /** `routes/_middleware.ts` answered instead of the route. */
  | "middleware"
  /** A CORS preflight, answered before anything else looked at the request. */
  | "preflight"
  /** CSRF verification refused the request. */
  | "rejected"
  /** Something threw and was not caught before the exit point. */
  | "error";

export interface RequestEvent {
  request: Request;
  /**
   * The public URL, with any trusted proxy headers already applied - the same
   * one the route saw.
   *
   * It carries the query string, which is where personal data ends up when it
   * ends up anywhere. Strip what you must before forwarding this off the box.
   */
  url: URL;
  method: string;
  kind: RequestKind;
  /**
   * The matched route pattern - `/blog/[slug]`, not `/blog/hello-world`.
   *
   * Null when nothing matched, or when the request never reached matching: an
   * asset, a preflight, a rejected request.
   */
  route: string | null;
  status: number;
  /**
   * Wall-clock milliseconds across the whole pipeline, as a float. Rounding is
   * left to whatever consumes this, because a static render is routinely faster
   * than one millisecond and rounding here would report it as zero.
   */
  durationMs: number;
  /** The thrown value, when `kind` is `"error"`. */
  error?: unknown;
  /**
   * Errors a `<Boundary>` absorbed while rendering.
   *
   * Present only when there were some. The request still succeeded - status is
   * 200 and the page carries the fallback - so these would otherwise never
   * reach a reporting backend, which is the difference between a degraded page
   * you know about and one you do not.
   */
  caught?: unknown[];
}

/**
 * Called once per request.
 *
 * Runs on the request's own path, so it is in front of the response: keep it to
 * handing the event to something else. An async observer is accepted and never
 * awaited - the request does not wait for a network call to a metrics backend,
 * and a rejected promise is reported rather than left unhandled.
 */
export type Observer = (event: RequestEvent) => void | Promise<void>;

/**
 * An observer that throws must not be able to turn a 200 into a 500.
 *
 * Reported once per process rather than once per request. A logger that is
 * broken is broken on every request, and a message repeated at request rate
 * would bury the failure it is describing along with everything else.
 */
let reportedFailure = false;

function reportFailure(error: unknown): void {
  if (reportedFailure) return;
  reportedFailure = true;
  console.error(
    "[stoneware] The configured `observe` hook threw. The request was served normally.\n" +
      "  Further failures from it will not be reported.",
    error,
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | null | undefined)?.then === "function";
}

/** Hand an event to the observer, absorbing anything it does wrong. */
export function notify(observer: Observer | null, event: RequestEvent): void {
  if (observer === null) return;

  try {
    const result = observer(event);
    if (isThenable(result)) result.then(undefined, reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}

export interface ConsoleObserverOptions {
  /**
   * Log static files too.
   *
   * Off by default: one page load is one page request and then every image,
   * stylesheet and island chunk on it, so including them turns the log into
   * something nobody reads.
   */
  assets?: boolean;
}

/**
 * The built-in observer: one line per request on the console.
 *
 * Installed automatically by `stoneware dev`. Production installs nothing unless
 * the project asks for it, which it can do with this same function.
 */
export function consoleObserver(options: ConsoleObserverOptions = {}): Observer {
  const includeAssets = options.assets ?? false;

  return (event) => {
    if (!includeAssets && event.kind === "asset") return;

    const line = formatEvent(event);
    if (event.status >= 500) console.error(line);
    else if (event.status >= 400) console.warn(line);
    else console.log(line);
  };
}

/**
 * The one-line form, exported so a project can keep the format while sending it
 * somewhere other than the console.
 */
export function formatEvent(event: RequestEvent): string {
  // Sub-millisecond is the normal case for a static render, so a fixed decimal
  // below 10ms and a whole number above it. Reporting "0ms" for the fast path
  // would make the thing the framework is for look unmeasurable.
  const duration =
    event.durationMs < 10 ? `${event.durationMs.toFixed(1)}ms` : `${Math.round(event.durationMs)}ms`;

  // Only when it says something the path does not. On `/about` the pattern and
  // the path are the same string and printing both is noise.
  const pattern = event.route !== null && event.route !== event.url.pathname ? `  ${event.route}` : "";

  const reason =
    event.error instanceof Error ? `  ${event.error.name}: ${event.error.message}` : "";

  // A 200 that quietly rendered a fallback is worth saying out loud. The errors
  // themselves are already on the console; this marks the request they belong
  // to, which is what makes them findable.
  const caught = event.caught?.length ? `  caught=${event.caught.length}` : "";

  return (
    `[stoneware] ${event.status} ${event.method.padEnd(4)} ${event.url.pathname}  ` +
    `${duration}${pattern}${reason}${caught}`
  );
}
