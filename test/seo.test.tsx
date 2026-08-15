/**
 * `seo()`: what it emits, what it leaves out, and what it infers.
 *
 * The central property is that an omitted field produces no tag at all - a page
 * that supplies a title and a description should not ship a dozen empty ones.
 */

import { describe, expect, test } from "bun:test";
import { renderToString } from "../src/render.ts";
import { seo } from "../src/seo.tsx";
import { withRenderContext } from "../src/context.ts";
import { resolveConfig } from "../src/config.ts";

const render = (child: ReturnType<typeof seo>) => renderToString(child).html;

/** A render context, as the server installs around every page render. */
function atOrigin<T>(origin: string, fn: () => T): T {
  const config = resolveConfig({ csrf: { secret: "seo-test-secret-0123456789ab" } }, true);
  return withRenderContext(
    {
      config,
      request: new Request(`${origin}/quiz/java`),
      url: new URL(`${origin}/quiz/java`),
      personalized: false,
      preloads: new Set<string>(),
      renderingHead: false,
      seoOutsideHead: false,

      caught: [],
    },
    fn,
  );
}

describe("the basics", () => {
  test("emits exactly the three tags the example asks for", () => {
    const html = render(
      seo({
        title: "Java Quiz",
        description: "Practice Java questions online.",
        canonical: "https://example.com/quiz/java",
      }),
    );

    expect(html).toBe(
      "<title>Java Quiz</title>" +
        '<meta name="description" content="Practice Java questions online.">' +
        '<link rel="canonical" href="https://example.com/quiz/java">',
    );
  });

  test("an omitted field produces no tag", () => {
    expect(render(seo({ title: "Only a title" }))).toBe("<title>Only a title</title>");
  });

  test("no options at all produces nothing", () => {
    expect(render(seo())).toBe("");
    expect(render(seo({}))).toBe("");
  });

  test("values are escaped", () => {
    const html = render(seo({ title: "5 < 6", description: '"><script>' }));

    expect(html).toContain("5 &lt; 6");
    expect(html).not.toContain("<script>");
  });
});

describe("open graph", () => {
  test("uses property, not name", () => {
    // `name="og:title"` is the most common mistake in hand-written OG tags, and
    // it silently does nothing.
    const html = render(seo({ openGraph: { title: "T" } }));

    expect(html).toContain('<meta property="og:title" content="T">');
    expect(html).not.toContain('name="og:title"');
  });

  test("title and description fall back to the top level", () => {
    const html = render(
      seo({ title: "Java Quiz", description: "Practice.", openGraph: { image: "/a.png" } }),
    );

    expect(html).toContain('property="og:title" content="Java Quiz"');
    expect(html).toContain('property="og:description" content="Practice."');
  });

  test("url falls back to canonical, and type defaults to website", () => {
    const html = render(seo({ canonical: "https://example.com/x", openGraph: {} }));

    expect(html).toContain('property="og:url" content="https://example.com/x"');
    expect(html).toContain('property="og:type" content="website"');
  });

  test("nothing is emitted for open graph unless asked for", () => {
    expect(render(seo({ title: "T" }))).not.toContain("og:");
  });
});

describe("absolute image URLs", () => {
  test("a relative image is resolved against canonical", () => {
    // A relative og:image is dropped by most crawlers, and the failure is
    // invisible until someone shares the link.
    const html = render(
      seo({
        canonical: "https://example.com/quiz/java",
        openGraph: { image: "/images/java-quiz.png" },
      }),
    );

    expect(html).toContain('content="https://example.com/images/java-quiz.png"');
  });

  test("falls back to the origin being rendered when there is no canonical", () => {
    const html = atOrigin("https://stoneware.dev", () =>
      render(seo({ openGraph: { image: "/images/x.png" } })),
    );

    expect(html).toContain('content="https://stoneware.dev/images/x.png"');
  });

  test("an already-absolute image is left alone", () => {
    const html = render(
      seo({ canonical: "https://example.com/", openGraph: { image: "https://cdn.test/x.png" } }),
    );

    expect(html).toContain('content="https://cdn.test/x.png"');
  });

  test("outside a render it is left as given rather than guessed at", () => {
    expect(render(seo({ openGraph: { image: "/x.png" } }))).toContain('content="/x.png"');
  });
});

describe("twitter", () => {
  test("card defaults to summary_large_image when there is an image", () => {
    const html = render(seo({ openGraph: { image: "https://cdn.test/x.png" }, twitter: {} }));

    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });

  test("card defaults to summary when there is not", () => {
    // A large-image card with no image renders as a bare link.
    const html = render(seo({ title: "T", twitter: {} }));

    expect(html).toContain('name="twitter:card" content="summary"');
  });

  test("an explicit card wins", () => {
    const html = render(seo({ twitter: { card: "player" } }));

    expect(html).toContain('content="player"');
  });

  test("title and description fall back through open graph to the top level", () => {
    const html = render(seo({ title: "Top", openGraph: { title: "OG" }, twitter: {} }));
    expect(html).toContain('name="twitter:title" content="OG"');

    const noOG = render(seo({ title: "Top", twitter: {} }));
    expect(noOG).toContain('name="twitter:title" content="Top"');
  });

  test("the image is inherited from open graph, absolute", () => {
    const html = render(
      seo({ canonical: "https://example.com/", openGraph: { image: "/x.png" }, twitter: {} }),
    );

    expect(html).toContain('name="twitter:image" content="https://example.com/x.png"');
  });
});

describe("robots", () => {
  test("index and follow", () => {
    expect(render(seo({ robots: { index: true, follow: true } }))).toContain(
      '<meta name="robots" content="index, follow">',
    );
  });

  test("their negatives", () => {
    expect(render(seo({ robots: { index: false, follow: false } }))).toContain(
      'content="noindex, nofollow"',
    );
  });

  test("only what was set", () => {
    expect(render(seo({ robots: { index: false } }))).toContain('content="noindex"');
  });
});

describe("composition", () => {
  test("the result sits alongside hand-written tags in one head", () => {
    // seo() is a convenience over writing tags, never a gate in front of them.
    const html = renderToString(
      <>
        {seo({ title: "T" })}
        <link rel="alternate" type="application/rss+xml" href="/feed.xml" />
      </>,
    ).html;

    expect(html).toBe(
      "<title>T</title><link rel=\"alternate\" type=\"application/rss+xml\" href=\"/feed.xml\">",
    );
  });
});

describe("X, formerly Twitter", () => {
  test("the option is x but the tags stay twitter:*", () => {
    // The company was renamed; the markup was not. An x:card tag would be
    // ignored by every crawler there is.
    const html = render(seo({ title: "T", x: { card: "summary" } }));

    expect(html).toContain('name="twitter:card"');
    expect(html).not.toContain("x:card");
  });

  test("twitter is accepted as an alias, and x wins if both are given", () => {
    expect(render(seo({ twitter: { card: "player" } }))).toContain('content="player"');
    expect(render(seo({ x: { card: "app" }, twitter: { card: "player" } }))).toContain(
      'content="app"',
    );
  });
});

describe("reach beyond the basics", () => {
  test("article metadata, for Google Discover and Facebook", () => {
    const html = render(
      seo({
        openGraph: {
          type: "article",
          article: {
            publishedTime: "2026-08-13",
            authors: ["https://example.com/authors/ada", "https://example.com/authors/grace"],
            tags: ["bun", "ssr"],
            section: "Engineering",
          },
        },
      }),
    );

    expect(html).toContain('property="article:published_time" content="2026-08-13"');
    expect(html).toContain('property="article:section" content="Engineering"');
    // Repeated properties, one tag each - not a comma-joined string.
    expect(html.match(/property="article:author"/g)).toHaveLength(2);
    expect(html.match(/property="article:tag"/g)).toHaveLength(2);
  });

  test("image dimensions, so a first share previews with its picture", () => {
    const html = render(seo({ openGraph: { image: "https://cdn.test/a.png", imageWidth: 1200, imageHeight: 630 } }));

    expect(html).toContain('property="og:image:width" content="1200"');
    expect(html).toContain('property="og:image:height" content="630"');
  });

  test("hreflang alternates", () => {
    const html = render(
      seo({
        alternates: [
          { hreflang: "en", href: "https://example.com/en" },
          { hreflang: "x-default", href: "https://example.com/" },
        ],
      }),
    );

    expect(html).toContain('<link rel="alternate" hreflang="en" href="https://example.com/en">');
    expect(html).toContain('hreflang="x-default"');
  });

  test("theme colour and the Facebook app id", () => {
    const html = render(seo({ themeColor: "#2f6f4e", facebookAppId: "1234567890" }));

    expect(html).toContain('<meta name="theme-color" content="#2f6f4e">');
    expect(html).toContain('<meta property="fb:app_id" content="1234567890">');
  });

  test("the extended robots directives", () => {
    const html = render(
      seo({ robots: { index: true, follow: true, maxImagePreview: "large", maxSnippet: -1 } }),
    );

    expect(html).toContain('content="index, follow, max-snippet:-1, max-image-preview:large"');
  });
});

describe("structured data for Google rich results", () => {
  test("serialized as a non-executable ld+json block", () => {
    const html = render(
      seo({ jsonLd: { "@context": "https://schema.org", "@type": "Quiz", name: "Java Quiz" } }),
    );

    expect(html).toContain('<script type="application/ld+json">');
    expect(html).toContain('"@type":"Quiz"');
  });

  test("an array of graphs is allowed", () => {
    const html = render(seo({ jsonLd: [{ "@type": "A" }, { "@type": "B" }] }));

    expect(html).toStartWith('<script type="application/ld+json">[');
  });

  test("it cannot break out of the script element", () => {
    // The one place escaping alone would not save us: a value ending the tag.
    const html = render(seo({ jsonLd: { name: "</script><script>alert(1)</script>" } }));

    expect(html).not.toContain("</script><script>");
    expect(html).toContain("\u003c");
  });
});
