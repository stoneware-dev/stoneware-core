/**
 * sitemap() — the parts people get wrong by hand.
 *
 * Escaping, absolute URLs, date formats and value ranges. A hand-written
 * sitemap usually looks fine and fails validation on one query string with an
 * ampersand in it, which is exactly the kind of thing a helper should own.
 */

import { describe, expect, test } from "bun:test";

import { sitemap, sitemapXML } from "../src/helpers/sitemap.ts";

const ORIGIN = "https://example.com";

describe("document shape", () => {
  test("is a valid urlset with one entry per URL", () => {
    const xml = sitemapXML([{ url: "/" }, { url: "/about" }], { origin: ORIGIN });

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<loc>https://example.com/</loc>");
    expect(xml).toContain("<loc>https://example.com/about</loc>");
    expect((xml.match(/<url>/g) ?? []).length).toBe(2);
    expect(xml.trimEnd().endsWith("</urlset>")).toBe(true);
  });

  test("an empty list is still a valid document", () => {
    const xml = sitemapXML([], { origin: ORIGIN });
    expect(xml).toContain("<urlset");
    expect(xml).not.toContain("<url>");
  });
});

describe("URLs", () => {
  test("paths are resolved against the origin", () => {
    const xml = sitemapXML([{ url: "/a" }, { url: "b" }], { origin: ORIGIN });
    expect(xml).toContain("<loc>https://example.com/a</loc>");
    expect(xml).toContain("<loc>https://example.com/b</loc>");
  });

  test("a trailing slash on the origin does not double up", () => {
    const xml = sitemapXML([{ url: "/a" }], { origin: "https://example.com/" });
    expect(xml).toContain("<loc>https://example.com/a</loc>");
  });

  test("absolute entries are left alone and need no origin", () => {
    const xml = sitemapXML([{ url: "https://other.example/x" }]);
    expect(xml).toContain("<loc>https://other.example/x</loc>");
  });

  test("a path with no origin is refused, naming the entry", () => {
    // Silently emitting a relative loc produces a document that parses and that
    // no crawler can use — the worst failure available here.
    expect(() => sitemapXML([{ url: "/" }, { url: "/oops" }])).toThrow(/entry 0|no origin/i);
  });

  test("XML entities are escaped, including the apostrophe", () => {
    // Bun.escapeHTML would leave the apostrophe alone and the ampersand is what
    // actually breaks parsers. Both are legal in a URL.
    const xml = sitemapXML([{ url: "/search?a=1&b=2&c='x'" }], { origin: ORIGIN });

    expect(xml).toContain("&amp;b=2");
    expect(xml).toContain("&apos;x&apos;");
    expect(xml).not.toMatch(/[^&]&[a-z]+=[^;]/);
  });

  test("a duplicated URL is written once", () => {
    const xml = sitemapXML([{ url: "/a" }, { url: "/a" }, { url: "/b" }], { origin: ORIGIN });
    expect((xml.match(/<url>/g) ?? []).length).toBe(2);
  });
});

describe("lastModified", () => {
  test("a date-only string is passed through unshifted", () => {
    // Round-tripping through Date would move it by the local UTC offset and
    // publish the wrong day for anyone west of Greenwich.
    const xml = sitemapXML([{ url: "/", lastModified: "2026-01-06" }], { origin: ORIGIN });
    expect(xml).toContain("<lastmod>2026-01-06</lastmod>");
  });

  test("a Date becomes full ISO", () => {
    const xml = sitemapXML([{ url: "/", lastModified: new Date("2026-01-06T12:00:00Z") }], {
      origin: ORIGIN,
    });
    expect(xml).toContain("<lastmod>2026-01-06T12:00:00.000Z</lastmod>");
  });

  test("an unreadable date is refused rather than emitted", () => {
    expect(() => sitemapXML([{ url: "/", lastModified: "last tuesday" }], { origin: ORIGIN })).toThrow(
      /not a date/i,
    );
    expect(() => sitemapXML([{ url: "/", lastModified: new Date("nope") }], { origin: ORIGIN })).toThrow(
      /invalid Date/i,
    );
  });

  test("omitted when not given", () => {
    expect(sitemapXML([{ url: "/" }], { origin: ORIGIN })).not.toContain("<lastmod>");
  });
});

describe("changeFrequency and priority", () => {
  test("valid values are emitted", () => {
    const xml = sitemapXML([{ url: "/", changeFrequency: "weekly", priority: 0.8 }], {
      origin: ORIGIN,
    });
    expect(xml).toContain("<changefreq>weekly</changefreq>");
    expect(xml).toContain("<priority>0.8</priority>");
  });

  test("an invalid frequency is refused with the allowed set", () => {
    expect(() =>
      // @ts-expect-error deliberately outside the union, which is what a
      // JavaScript caller would hand over.
      sitemapXML([{ url: "/", changeFrequency: "often" }], { origin: ORIGIN }),
    ).toThrow(/valid changeFrequency/i);
  });

  test("priority outside 0..1 is refused", () => {
    expect(() => sitemapXML([{ url: "/", priority: 1.5 }], { origin: ORIGIN })).toThrow(/range/i);
    expect(() => sitemapXML([{ url: "/", priority: -1 }], { origin: ORIGIN })).toThrow(/range/i);
    expect(() => sitemapXML([{ url: "/", priority: NaN }], { origin: ORIGIN })).toThrow(/range/i);
  });

  test("priority 0 is a real value, not an omission", () => {
    expect(sitemapXML([{ url: "/", priority: 0 }], { origin: ORIGIN })).toContain(
      "<priority>0.0</priority>",
    );
  });
});

describe("limits", () => {
  test("beyond the protocol ceiling it refuses and says what to do", () => {
    const many = Array.from({ length: 50_001 }, (_, i) => ({ url: `/p/${i}` }));
    expect(() => sitemapXML(many, { origin: ORIGIN })).toThrow(/50000|sitemap index/i);
  });
});

describe("the response", () => {
  test("carries the XML content type and revalidates", async () => {
    const response = sitemap([{ url: "/" }], { origin: ORIGIN });

    expect(response.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, no-cache");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toContain("<loc>https://example.com/</loc>");
  });
});
