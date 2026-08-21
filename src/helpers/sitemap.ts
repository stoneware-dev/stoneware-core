/**
 * `sitemap.xml`, generated rather than maintained.
 *
 * The scaffold used to ship a route holding `const PATHS = ["/"]` and a comment
 * asking you to keep it up to date. That is a sitemap that is wrong by the
 * second page, and being wrong is worse than being absent: a sitemap listing
 * URLs that 404 is a signal search engines act on.
 *
 * What this does NOT do is enumerate your routes for you. The framework knows
 * every pattern, so it could - but it cannot know which ones belong in a
 * sitemap. A checkout confirmation, a page behind a login, a paginated archive
 * you would rather have crawled through links: all of those are routes, and
 * none of them belong here. Listing what should be indexed is an editorial
 * decision, and guessing at it would produce a file that is confidently wrong.
 *
 * So the entries are yours. What this owns is everything about turning them
 * into a valid document: escaping, absolute URLs, date formats, the value
 * ranges the schema allows, and the protocol's size limits.
 *
 *   // routes/sitemap.xml.ts
 *   import { sitemap } from "stoneware";
 *   import { ARTICLES } from "../../lib/content.ts";
 *
 *   export function GET() {
 *     return sitemap(
 *       [
 *         { url: "/" },
 *         ...ARTICLES.map((a) => ({ url: `/articles/${a.slug}`, lastModified: a.published })),
 *       ],
 *       { origin: "https://example.com" },
 *     );
 *   }
 */

/** How often the page changes, in the vocabulary the schema allows. */
export type ChangeFrequency =
  | "always"
  | "hourly"
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "never";

export interface SitemapEntry {
  /**
   * Absolute URL, or a path resolved against `origin`.
   *
   * The protocol requires absolute URLs. A path is accepted because that is
   * what a route module has to hand, and forgetting the origin is the single
   * most common way to publish a sitemap no crawler can use.
   */
  url: string;
  /** Last modification. A Date, an ISO string, or a `YYYY-MM-DD` string. */
  lastModified?: Date | string;
  changeFrequency?: ChangeFrequency;
  /** 0 to 1. Relative to your own other pages, not to anyone else's. */
  priority?: number;
}

export interface SitemapOptions {
  /**
   * Origin for entries given as paths, with no trailing slash.
   *
   * Required unless every entry is already absolute. It is not derived from the
   * request: behind a TLS-terminating proxy the request origin is the internal
   * one, and a sitemap full of `http://` URLs for an `https://` site is the
   * exact bug this would otherwise cause on every managed host.
   */
  origin?: string;
}

/** The protocol's ceiling. Beyond this a sitemap index is required. */
const MAX_ENTRIES = 50_000;

const CHANGE_FREQUENCIES: ReadonlySet<string> = new Set([
  "always",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "never",
]);

/**
 * XML, not HTML.
 *
 * `Bun.escapeHTML` is the wrong tool here: an apostrophe is legal in a URL and
 * has to be escaped in XML, and the entity sets are not the same. A query
 * string with `&` in it produces a document no parser will accept.
 */
function escapeXML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** W3C datetime: a plain date stays a plain date, anything else is full ISO. */
function formatLastModified(value: Date | string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new TypeError("sitemap(): lastModified is an invalid Date.");
    }
    return value.toISOString();
  }

  // Already a date-only string; passing it through Date would drift it by the
  // local timezone offset and publish yesterday's date for half the world.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`sitemap(): lastModified "${value}" is not a date Stoneware can read.`);
  }
  return parsed.toISOString();
}

function resolveURL(url: string, origin: string | undefined, index: number): string {
  if (/^https?:\/\//i.test(url)) return url;

  if (origin === undefined) {
    throw new TypeError(
      `sitemap(): entry ${index} is the path "${url}", but no origin was given.\n` +
        `  A sitemap must contain absolute URLs. Pass { origin: "https://example.com" }, ` +
        `or make every entry absolute.`,
    );
  }

  const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return url.startsWith("/") ? `${base}${url}` : `${base}/${url}`;
}

/**
 * The sitemap document, as a string.
 *
 * Separate from `sitemap()` so it can be written to a file, snapshotted in a
 * test, or embedded in a sitemap index without going through a Response.
 */
export function sitemapXML(entries: SitemapEntry[], options: SitemapOptions = {}): string {
  if (entries.length > MAX_ENTRIES) {
    throw new RangeError(
      `sitemap(): ${entries.length} entries exceeds the protocol limit of ${MAX_ENTRIES}.\n` +
        `  Split them across several sitemaps and list those in a sitemap index.`,
    );
  }

  const seen = new Set<string>();
  const body = entries
    .map((entry, index) => {
      const loc = resolveURL(entry.url, options.origin, index);

      // A duplicated URL is not fatal, but it is always a mistake - two data
      // sources overlapping, usually - and the file is smaller without it.
      if (seen.has(loc)) return "";
      seen.add(loc);

      let out = `  <url>\n    <loc>${escapeXML(loc)}</loc>\n`;

      if (entry.lastModified !== undefined) {
        out += `    <lastmod>${formatLastModified(entry.lastModified)}</lastmod>\n`;
      }

      if (entry.changeFrequency !== undefined) {
        if (!CHANGE_FREQUENCIES.has(entry.changeFrequency)) {
          throw new TypeError(
            `sitemap(): "${entry.changeFrequency}" is not a valid changeFrequency. ` +
              `Expected one of ${[...CHANGE_FREQUENCIES].join(", ")}.`,
          );
        }
        out += `    <changefreq>${entry.changeFrequency}</changefreq>\n`;
      }

      if (entry.priority !== undefined) {
        if (!Number.isFinite(entry.priority) || entry.priority < 0 || entry.priority > 1) {
          throw new RangeError(
            `sitemap(): priority ${entry.priority} is outside the allowed range 0 to 1.`,
          );
        }
        out += `    <priority>${entry.priority.toFixed(1)}</priority>\n`;
      }

      return out + "  </url>\n";
    })
    .join("");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    body +
    `</urlset>\n`
  );
}

/**
 * A `sitemap.xml` response.
 *
 * `no-cache` rather than a max-age: the file changes whenever content is
 * published, and a crawler holding a stale copy for an hour is the failure this
 * is meant to prevent. It revalidates, so an unchanged sitemap still costs one
 * conditional request.
 */
export function sitemap(entries: SitemapEntry[], options: SitemapOptions = {}): Response {
  return new Response(sitemapXML(entries, options), {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
