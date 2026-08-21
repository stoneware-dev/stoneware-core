/**
 * `seo()` - the metadata tags a page actually needs, from one object.
 *
 * Every field is optional and nothing is emitted for a field you leave out.
 * That is the point: a page with a title and a description should produce two
 * tags, not a wall of empty ones. Nothing here is required in order to use
 * `head()` - this is a convenience over writing the tags yourself, not a gate
 * in front of them, and the result composes with hand-written tags in the same
 * fragment.
 *
 * There is no per-network option list, because there is no per-network
 * protocol. Facebook, Instagram, LinkedIn, WhatsApp, Slack, Discord, Telegram,
 * Signal, Pinterest, iMessage and Teams all read Open Graph. X reads its own
 * `twitter:*` tags. Google reads the title, description, canonical, robots and
 * structured data. That is the whole landscape - five inputs, not twenty.
 *
 * Values are escaped by the renderer like any other interpolation, because
 * these are ordinary vnodes rather than a string of markup.
 */

import { noteSEOCall, peekRenderContext } from "./context.ts";
import { raw, safeJSONStringify } from "./escape.ts";
import { Fragment, h } from "./jsx-runtime.ts";
import type { Child } from "./types.ts";

/**
 * Open Graph is the one that pays for itself.
 *
 * Every messaging app and social network except X reads these tags, which is
 * why there is no `linkedIn` or `slack` or `instagram` option here - there
 * would be nothing to put in it.
 */
export interface OpenGraphOptions {
  /** Falls back to the top-level `title`. */
  title?: string;
  /** Falls back to the top-level `description`. */
  description?: string;
  /** Relative paths are resolved against `canonical`, or the current origin. */
  image?: string;
  imageAlt?: string;
  /**
   * Image dimensions. Worth setting: without them a network has to fetch the
   * image before it can lay out the card, which is why a freshly shared link
   * often previews without its picture the first time.
   */
  imageWidth?: number;
  imageHeight?: number;
  /** Defaults to `"website"`. Use `"article"` for posts. */
  type?: string;
  siteName?: string;
  /** Falls back to `canonical`. */
  url?: string;
  /** e.g. `en_GB`. Underscored, not hyphenated - Open Graph is not BCP 47. */
  locale?: string;
  /** Only meaningful with `type: "article"`. */
  article?: ArticleOptions;
}

/** Article metadata, read by Google Discover, Facebook and LinkedIn. */
export interface ArticleOptions {
  /** ISO 8601, e.g. `2026-08-13` or a full timestamp. */
  publishedTime?: string;
  modifiedTime?: string;
  expirationTime?: string;
  /** Author profile URLs, not names. */
  authors?: string[];
  section?: string;
  tags?: string[];
}

/**
 * Card metadata for X, formerly Twitter.
 *
 * The company was renamed; the markup was not. X still reads `twitter:card`,
 * `twitter:title` and the rest, so that is what these emit. An `x:card` tag
 * would be ignored by every crawler there is, which makes the old prefix
 * correct rather than out of date.
 */
export interface XCardOptions {
  /** Defaults to `summary_large_image` when there is an image, else `summary`. */
  card?: "summary" | "summary_large_image" | "app" | "player";
  /** `@handle` of the site. */
  site?: string;
  /** `@handle` of the author. */
  creator?: string;
  /** Each falls back to the Open Graph value, then the top-level one. */
  title?: string;
  description?: string;
  image?: string;
  imageAlt?: string;
}

/** @deprecated Prefer `XCardOptions`. Kept because the tags are still `twitter:*`. */
export type TwitterOptions = XCardOptions;

export interface RobotsOptions {
  index?: boolean;
  follow?: boolean;
  /** Google-specific, but widely honoured. `-1` means no limit. */
  maxSnippet?: number;
  maxImagePreview?: "none" | "standard" | "large";
  /** Do not offer a cached copy. */
  noarchive?: boolean;
}

/** One `hreflang` alternate. */
export interface AlternateLink {
  /** BCP 47, or `"x-default"`. */
  hreflang: string;
  href: string;
}

export interface SEOOptions {
  title?: string;
  description?: string;
  canonical?: string;
  openGraph?: OpenGraphOptions;
  /** X, formerly Twitter. Emits `twitter:*`, which is what X still reads. */
  x?: XCardOptions;
  /** Alias for `x`, for familiarity. `x` wins if both are given. */
  twitter?: XCardOptions;
  robots?: RobotsOptions;
  /**
   * Translations of this page, as `hreflang` links. Google uses these to serve
   * the right language rather than treating them as duplicate content.
   */
  alternates?: AlternateLink[];
  /** Facebook app id, for Insights. Nothing else reads it. */
  facebookAppId?: string;
  /** Browser chrome on mobile, and the accent stripe on Slack and Discord. */
  themeColor?: string;
  /**
   * schema.org structured data, as an object or an array of them.
   *
   * This is the lever for Google rich results - stars, breadcrumbs, FAQ
   * accordions, recipe cards - and none of the tags above can produce them.
   * Serialized as a `application/ld+json` data block, which browsers never
   * execute and CSP does not govern.
   */
  jsonLd?: object | object[];
}

export function seo(options: SEOOptions = {}): Child {
  // Records where this was called from, so the server can warn if the tags
  // landed in <body>, where they do nothing.
  noteSEOCall();

  const { title, description, canonical, openGraph, robots, alternates } = options;
  const xCard = options.x ?? options.twitter;

  const tags: Child[] = [];

  if (title !== undefined) tags.push(h("title", null, title));
  if (description !== undefined) tags.push(meta({ name: "description", content: description }));
  if (canonical !== undefined) tags.push(h("link", { rel: "canonical", href: canonical }));
  if (robots !== undefined) tags.push(meta({ name: "robots", content: robotsContent(robots) }));
  if (options.themeColor !== undefined) {
    tags.push(meta({ name: "theme-color", content: options.themeColor }));
  }

  for (const alternate of alternates ?? []) {
    tags.push(h("link", { rel: "alternate", hreflang: alternate.hreflang, href: alternate.href }));
  }

  // Relative image paths are resolved here rather than left to the crawler.
  // og:image must be absolute - a relative one is simply dropped by most of
  // them, and the failure is invisible until someone shares the link.
  const base = canonical;

  if (openGraph !== undefined) {
    const ogImage = absolute(openGraph.image, base);

    tags.push(property("og:type", openGraph.type ?? "website"));
    tags.push(property("og:title", openGraph.title ?? title));
    tags.push(property("og:description", openGraph.description ?? description));
    tags.push(property("og:url", openGraph.url ?? canonical));
    tags.push(property("og:site_name", openGraph.siteName));
    tags.push(property("og:locale", openGraph.locale));
    tags.push(property("og:image", ogImage));
    tags.push(property("og:image:alt", openGraph.imageAlt));
    tags.push(property("og:image:width", numeric(openGraph.imageWidth)));
    tags.push(property("og:image:height", numeric(openGraph.imageHeight)));

    const article = openGraph.article;
    if (article !== undefined) {
      tags.push(property("article:published_time", article.publishedTime));
      tags.push(property("article:modified_time", article.modifiedTime));
      tags.push(property("article:expiration_time", article.expirationTime));
      tags.push(property("article:section", article.section));
      for (const author of article.authors ?? []) tags.push(property("article:author", author));
      for (const tag of article.tags ?? []) tags.push(property("article:tag", tag));
    }
  }

  if (options.facebookAppId !== undefined) {
    tags.push(property("fb:app_id", options.facebookAppId));
  }

  if (xCard !== undefined) {
    const cardImage = absolute(xCard.image ?? openGraph?.image, base);

    // A large-image card with no image renders as a bare link, so the default
    // follows what is actually available rather than being a fixed string.
    const card = xCard.card ?? (cardImage !== undefined ? "summary_large_image" : "summary");

    tags.push(meta({ name: "twitter:card", content: card }));
    tags.push(meta({ name: "twitter:site", content: xCard.site }));
    tags.push(meta({ name: "twitter:creator", content: xCard.creator }));
    tags.push(meta({ name: "twitter:title", content: xCard.title ?? openGraph?.title ?? title }));
    tags.push(
      meta({
        name: "twitter:description",
        content: xCard.description ?? openGraph?.description ?? description,
      }),
    );
    tags.push(meta({ name: "twitter:image", content: cardImage }));
    tags.push(meta({ name: "twitter:image:alt", content: xCard.imageAlt ?? openGraph?.imageAlt }));
  }

  if (options.jsonLd !== undefined) tags.push(jsonLdScript(options.jsonLd));

  return h(Fragment, null, ...tags.filter((tag) => tag !== null));
}

/** A tag, or null when there is no value - filtered out before rendering. */
function meta(attributes: { name: string; content: string | undefined }): Child {
  if (attributes.content === undefined) return null;
  return h("meta", { name: attributes.name, content: attributes.content });
}

function property(name: string, content: string | undefined): Child {
  if (content === undefined) return null;
  // Open Graph uses `property`, not `name`. Using `name` is the single most
  // common mistake in hand-written OG tags and it silently does nothing.
  return h("meta", { property: name, content });
}

function numeric(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

/**
 * Structured data as a non-executable data block.
 *
 * `raw()` is required because the renderer refuses to interpolate values into a
 * `<script>` body - escaping cannot make that safe in general. It is sound
 * here for the same reason the island payload is: `safeJSONStringify` escapes
 * `<`, `>`, `&` and the line separators, so the serialized value cannot close
 * the element or introduce markup. The type is `application/ld+json`, which
 * browsers parse as data and never execute.
 */
function jsonLdScript(data: object | object[]): Child {
  const payload = safeJSONStringify(data);
  return h("script", { type: "application/ld+json" }, raw(payload));
}

function robotsContent(robots: RobotsOptions): string {
  const directives: string[] = [];
  if (robots.index !== undefined) directives.push(robots.index ? "index" : "noindex");
  if (robots.follow !== undefined) directives.push(robots.follow ? "follow" : "nofollow");
  if (robots.noarchive) directives.push("noarchive");
  if (robots.maxSnippet !== undefined) directives.push(`max-snippet:${robots.maxSnippet}`);
  if (robots.maxImagePreview !== undefined) {
    directives.push(`max-image-preview:${robots.maxImagePreview}`);
  }
  return directives.join(", ");
}

/**
 * Make a URL absolute, because Open Graph and X cards both require it.
 *
 * Resolved against `canonical` when there is one, otherwise the origin of the
 * request being rendered. Outside a render - a standalone `renderToString` in a
 * test - the value is left exactly as given rather than guessed at.
 */
function absolute(url: string | undefined, base: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return url;

  const origin = base ?? peekRenderContext()?.url.origin;
  if (origin === undefined) return url;

  try {
    return new URL(url, origin).href;
  } catch {
    // A base that is not a valid URL is the author's to fix; emitting the
    // original is better than emitting nothing at all.
    return url;
  }
}

export default seo;
