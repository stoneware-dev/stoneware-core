/**
 * Route patterns in, matched route out.
 *
 * Discovery still belongs to `Bun.FileSystemRouter`: it derives Next.js-style
 * patterns from filenames, and reimplementing that would be reimplementing a
 * convention rather than a behaviour. What lives here is the *matching* half,
 * for two reasons.
 *
 * The first is deployment. `FileSystemRouter.match()` needs `routes/` on disk,
 * so a production bundle that inlines every route still could not serve one
 * without shipping the source tree beside it. A pattern table is data, and data
 * survives being written to a manifest and read back on another machine.
 *
 * The second is that Bun 1.3.14 aborts the process - a native panic, not a
 * catchable exception - when a path containing "%" reaches `match()`. Request
 * paths are attacker-controlled, so `GET /%41` was a remote denial of service.
 * That was worked around by masking "%" behind a sentinel before handing the
 * path over; matching here instead removes the reason for the workaround.
 */

export type Segment =
  | { kind: "literal"; value: string }
  | { kind: "param"; name: string }
  /** `[...rest]` - one segment or more. */
  | { kind: "catchall"; name: string }
  /** `[[...rest]]` - zero segments or more. */
  | { kind: "optional"; name: string };

export interface CompiledRoute {
  /** The route pattern, e.g. `/blog/[slug]`. */
  pattern: string;
  /** Absolute path to the module that serves it. */
  filePath: string;
  segments: Segment[];
  /**
   * Index of the catch-all segment, or -1 when there is none.
   *
   * A route without one matches a path of exactly its own length, which is a
   * comparison rather than a walk - so most candidates are rejected before the
   * loop starts.
   */
  restIndex: number;
}

/**
 * The route table, arranged for matching rather than for reading.
 *
 * Splitting literal patterns out is what keeps matching flat as a project
 * grows. Scanning is linear in the number of routes, and a content site is
 * mostly literal paths: at 300 routes the old scan cost ~9us per request, all
 * of it spent rejecting patterns that could not have matched.
 *
 * Trying literals first is not a change of precedence. Whenever a literal and a
 * dynamic route can both match one path, the literal is already the one the
 * sort puts first - it ranks 0 at the position where they differ, and the
 * dynamic route ranks at least 1.
 */
export interface RouteIndex {
  /** Fully-literal patterns, keyed on their decoded path with no slashes. */
  literals: Map<string, CompiledRoute>;
  /** Everything with a dynamic segment, most-specific first. */
  dynamic: CompiledRoute[];
  /** Every route in match order. For diagnostics - `stoneware routes` reads it. */
  all: CompiledRoute[];
}

export interface RouteMatch {
  pattern: string;
  filePath: string;
  params: Record<string, string>;
}

/**
 * Rank used to order overlapping routes: the lower, the more specific.
 *
 * A literal beats a param beats a catch-all at the same position, which is the
 * precedence Next.js documents and the one developers arriving from it expect.
 */
function rank(segment: Segment): number {
  switch (segment.kind) {
    case "literal":
      return 0;
    case "param":
      return 1;
    case "catchall":
      return 2;
    case "optional":
      return 3;
  }
}

function parseSegment(raw: string): Segment {
  if (raw.startsWith("[[...") && raw.endsWith("]]")) {
    return { kind: "optional", name: raw.slice(5, -2) };
  }
  if (raw.startsWith("[...") && raw.endsWith("]")) {
    return { kind: "catchall", name: raw.slice(4, -1) };
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return { kind: "param", name: raw.slice(1, -1) };
  }
  return { kind: "literal", value: raw };
}

function parsePattern(pattern: string): Segment[] {
  return pattern.split("/").filter(Boolean).map(parseSegment);
}

/**
 * Compile a pattern table into a list ordered most-specific first, so the first
 * match is the right one and matching never has to score candidates.
 */
export function compileRoutes(routes: Record<string, string>): RouteIndex {
  const all = Object.entries(routes).map(([pattern, filePath]) => {
    const segments = parsePattern(pattern);
    return {
      pattern,
      filePath,
      segments,
      restIndex: segments.findIndex((s) => s.kind === "catchall" || s.kind === "optional"),
    };
  });

  all.sort((a, b) => {
    const shared = Math.min(a.segments.length, b.segments.length);
    for (let i = 0; i < shared; i++) {
      const difference = rank(a.segments[i]!) - rank(b.segments[i]!);
      if (difference !== 0) return difference;
    }
    // Same shape as far as both go: the longer pattern is the more specific one.
    // Only one of them can match a given path anyway, so this is for determinism
    // rather than correctness.
    return b.segments.length - a.segments.length;
  });

  const literals = new Map<string, CompiledRoute>();
  const dynamic: CompiledRoute[] = [];

  for (const route of all) {
    if (route.segments.every((segment) => segment.kind === "literal")) {
      // Keyed the way a request path arrives once decoded and split, so the
      // lookup needs no work beyond joining what `decodeSegments` returned.
      literals.set(route.segments.map((segment) => (segment as { value: string }).value).join("/"), route);
    } else {
      dynamic.push(route);
    }
  }

  return { literals, dynamic, all };
}

/**
 * Split a request path into decoded segments.
 *
 * Splitting happens *before* decoding, deliberately. Decoding first would turn
 * "%2F" into a real "/" and let one encoded segment satisfy a two-segment route,
 * which is a classic path-confusion bypass.
 *
 * Returns null for anything that cannot be matched safely - malformed escapes, a
 * NUL byte, an empty segment - which the caller treats as a 404.
 */
export function decodeSegments(pathname: string): string[] | null {
  if (pathname.includes("\0")) return null;

  const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return [];

  const parts = trimmed.split("/");
  const decoded: string[] = [];

  for (const part of parts) {
    // "/a//b" - an empty segment is not a path Stoneware serves, and treating it
    // as absent would make two different URLs resolve to one route.
    if (part === "") return null;

    try {
      const value = decodeURIComponent(part);
      if (value.includes("\0")) return null;
      decoded.push(value);
    } catch {
      // e.g. "/blog/%zz" or a bare "%" - not a valid escape sequence.
      return null;
    }
  }

  return decoded;
}

/**
 * Params are allocated only once something is actually captured.
 *
 * Most candidates a scan looks at fail, and the object built for them was
 * thrown away immediately - one allocation per route per request, on a path
 * where nothing has matched yet.
 */
function matchSegments(segments: Segment[], parts: string[]): Record<string, string> | null {
  let params: Record<string, string> | null = null;

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;

    if (segment.kind === "catchall" || segment.kind === "optional") {
      // A catch-all is only ever the last segment, and swallows what is left.
      const rest = parts.slice(i);
      if (rest.length === 0 && segment.kind === "catchall") return null;
      if (rest.length > 0) (params ??= {})[segment.name] = rest.join("/");
      return params ?? {};
    }

    const part = parts[i];
    if (part === undefined) return null;

    if (segment.kind === "literal") {
      if (segment.value !== part) return null;
    } else {
      (params ??= {})[segment.name] = part;
    }
  }

  // No catch-all consumed the tail, so anything left over is a different route.
  return parts.length === segments.length ? (params ?? {}) : null;
}

/** First matching route, or null. `index` must come from `compileRoutes`. */
export function matchRoute(index: RouteIndex, pathname: string): RouteMatch | null {
  const parts = decodeSegments(pathname);
  if (parts === null) return null;

  const literal = index.literals.get(parts.join("/"));
  if (literal !== undefined) {
    return { pattern: literal.pattern, filePath: literal.filePath, params: {} };
  }

  for (const route of index.dynamic) {
    // A route with no catch-all matches a path of exactly its own length. Most
    // candidates fail here, before the walk.
    if (route.restIndex === -1 && route.segments.length !== parts.length) continue;

    const params = matchSegments(route.segments, parts);
    if (params !== null) {
      return { pattern: route.pattern, filePath: route.filePath, params };
    }
  }

  return null;
}
