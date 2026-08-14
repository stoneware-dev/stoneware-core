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
export function compileRoutes(routes: Record<string, string>): CompiledRoute[] {
  const compiled = Object.entries(routes).map(([pattern, filePath]) => ({
    pattern,
    filePath,
    segments: parsePattern(pattern),
  }));

  return compiled.sort((a, b) => {
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

function matchSegments(segments: Segment[], parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;

    if (segment.kind === "catchall" || segment.kind === "optional") {
      // A catch-all is only ever the last segment, and swallows what is left.
      const rest = parts.slice(i);
      if (rest.length === 0 && segment.kind === "catchall") return null;
      if (rest.length > 0) params[segment.name] = rest.join("/");
      return params;
    }

    const part = parts[i];
    if (part === undefined) return null;

    if (segment.kind === "literal") {
      if (segment.value !== part) return null;
    } else {
      params[segment.name] = part;
    }
  }

  // No catch-all consumed the tail, so anything left over is a different route.
  return parts.length === segments.length ? params : null;
}

/** First matching route, or null. `routes` must come from `compileRoutes`. */
export function matchRoute(routes: CompiledRoute[], pathname: string): RouteMatch | null {
  const parts = decodeSegments(pathname);
  if (parts === null) return null;

  for (const route of routes) {
    const params = matchSegments(route.segments, parts);
    if (params !== null) {
      return { pattern: route.pattern, filePath: route.filePath, params };
    }
  }

  return null;
}
