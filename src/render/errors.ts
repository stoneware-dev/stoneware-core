/**
 * Naming the components a render error passed through.
 *
 * Split from the walk because it is the walk's opposite number: `render.ts`
 * cares about the way in, this file cares about the way out. A depth-first
 * renderer discovers a bad value with nothing on the stack but itself —
 * `renderChild` called by `renderElement` called by `renderChild` — which names
 * the mechanism and not one line of the project's own code.
 *
 * So frames are recorded as the error unwinds and the path assembles itself.
 * The cost of that is the reason this is worth reading before changing: it is
 * try/catch on *components only*. Wrapping every element cost 38% of a page
 * render, and there is a test asserting intermediate elements stay out.
 */

/**
 * Which components a render error passed through on its way out.
 *
 * The renderer is a depth-first walk, so by the time an unsupported value is
 * discovered the only thing on the stack is the renderer itself: `renderChild`
 * called by `renderElement` called by `renderChild`, over and over. That names
 * the mechanism and not one line of the project's own code, which is the
 * opposite of what a stack trace is for.
 *
 * The walk *does* know, though - it just knows it on the way in, and the error
 * happens on the way out. So each component and element frame catches, records
 * its own name, and rethrows. The path assembles itself as the error unwinds,
 * costs nothing when nothing throws, and needs no bookkeeping on the hot path.
 */
const RENDER_ERROR = Symbol.for("stoneware.renderError");
const COMPONENT_PATH = Symbol.for("stoneware.componentPath");

interface RenderErrorParts {
  /** First line: what went wrong. */
  headline: string;
  /** Everything after the path: what to do about it. */
  detail: string;
}

type Annotated = {
  [RENDER_ERROR]?: RenderErrorParts;
  [COMPONENT_PATH]?: string[];
};

/**
 * A render error the framework raised itself.
 *
 * Held as parts rather than a finished string because the path belongs between
 * them, and the path is not known until the error has finished unwinding.
 */
export function renderError(parts: RenderErrorParts): TypeError {
  const error = new TypeError(`${parts.headline}\n\n${parts.detail}`);

  // Drop this factory from the trace. Without it the first frame - and the
  // source excerpt printed above it - is the line inside render.ts that
  // constructs the error, which is the least informative line in the whole
  // stack and sits exactly where someone looks first.
  Error.captureStackTrace?.(error, renderError);

  Object.defineProperty(error, RENDER_ERROR, {
    value: parts,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return error;
}

/** Record one frame. Anything not an object - a thrown string - is left alone. */
export function noteFrame(error: unknown, frame: string): void {
  if (typeof error !== "object" || error === null) return;
  const annotated = error as Annotated;

  let path = annotated[COMPONENT_PATH];
  if (path === undefined) {
    path = [];
    // Non-enumerable, or every console.error that prints this error also prints
    // `stoneware.componentPath: [ "<span>", ... ]` after the stack - the same
    // information a second time, as noise, in the one place someone is already
    // reading carefully.
    Object.defineProperty(error, COMPONENT_PATH, {
      value: path,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

  // Capped: a deep tree would otherwise append a hundred frames, and the ones
  // that identify the problem are the innermost few.
  if (path.length < MAX_PATH_FRAMES) path.push(frame);
}

const MAX_PATH_FRAMES = 12;

/**
 * The components an error passed through, innermost first.
 *
 * Exported so the request pipeline can report it for *any* error, not only the
 * framework's own: a database driver that throws inside a template gets the
 * same "which component" answer, without its message being rewritten.
 */
export function componentPathOf(error: unknown): string[] | null {
  if (typeof error !== "object" || error === null) return null;
  const path = (error as Annotated)[COMPONENT_PATH];
  return path && path.length > 0 ? path : null;
}

/** Render the collected path as indented `in <X>` lines. */
export function formatComponentPath(path: string[]): string {
  const lines = path.map((frame) => `  in ${frame}`);
  if (path.length >= MAX_PATH_FRAMES) lines.push("  in ... (outer frames omitted)");
  return lines.join("\n");
}

/**
 * Fold the collected path into the message, once.
 *
 * Only for errors the framework raised. A thrown value from project code keeps
 * its own message exactly as written - the path is still attached, and the
 * server logs it separately.
 */
export function finalizeRenderError(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return error;

  const annotated = error as Annotated;
  const parts = annotated[RENDER_ERROR];
  if (parts === undefined) return error;

  // Cleared first, so an error that passes through two renders - a boundary
  // fallback that rethrows, say - is not annotated twice.
  delete annotated[RENDER_ERROR];

  const path = annotated[COMPONENT_PATH];
  if (path === undefined || path.length === 0) return error;

  (error as { message: string }).message =
    `${parts.headline}\n\n${formatComponentPath(path)}\n\n${parts.detail}`;
  return error;
}

/**
 * What the unsupported value actually was.
 *
 * "Cannot render value of type object" is true of a Date, a database row, a
 * Map, and a class instance, and the fix is different for each. Keys are named
 * rather than values printed: `{ id, title, price }` is enough to recognise a
 * product row, while dumping the values would put whatever the row holds into
 * a log line.
 */
export function describeValue(value: object): string {
  if (value instanceof Date) {
    return "a Date. Format it first - {date.toISOString()} or your own helper";
  }
  if (value instanceof Map || value instanceof Set) {
    return `a ${value.constructor.name} of size ${value.size}. Render [...value] instead`;
  }
  if (value instanceof Promise) {
    return "a Promise. Only a route's default export may be async";
  }

  const name = value.constructor?.name;
  if (name !== undefined && name !== "Object") {
    return `an instance of ${name}. Render the fields you want, not the object`;
  }

  const keys = Object.keys(value);
  if (keys.length === 0) return "a plain object with no keys";

  const shown = keys.slice(0, 8).join(", ");
  const rest = keys.length > 8 ? `, ... (${keys.length} keys)` : "";
  return `a plain object with keys: ${shown}${rest}`;
}
