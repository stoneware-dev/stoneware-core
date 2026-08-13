/**
 * `<Image>`: the markup it produces, and what it refuses to produce.
 *
 * The preload half needs a render context, because that is the mechanism a tag
 * in the body uses to reach the head.
 */

import { describe, expect, test } from "bun:test";
import { Image } from "../src/image.tsx";
import { buildDocument } from "../src/document.ts";
import { renderToString } from "../src/render.ts";
import { withRenderContext } from "../src/context.ts";
import { resolveConfig } from "../src/config.ts";

const html = (tree: Parameters<typeof renderToString>[0]) => renderToString(tree).html;

/** A render context, as the server installs around every page render. */
function inRender<T>(fn: (preloads: Set<string>) => T): T {
  const preloads = new Set<string>();
  const config = resolveConfig({ csrf: { secret: "image-test-secret-0123456789ab" } }, true);
  return withRenderContext(
    {
      config,
      request: new Request("http://localhost/"),
      url: new URL("http://localhost/"),
      personalized: false,
      preloads,
    },
    () => fn(preloads),
  );
}

describe("markup", () => {
  test("a normal image is lazy and decodes off the main thread", () => {
    const out = html(<Image src="/images/feature.jpg" width={800} height={500} alt="Feature" />);

    expect(out).toContain('src="/images/feature.jpg"');
    expect(out).toContain('width="800"');
    expect(out).toContain('height="500"');
    expect(out).toContain('alt="Feature"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('decoding="async"');
    expect(out).not.toContain("fetchpriority");
  });

  test("a priority image is eager and high priority instead", () => {
    // loading="lazy" on the LCP image measurably delays it, so the two must
    // never appear together.
    const out = inRender(() =>
      html(<Image src="/hero.jpg" width={1200} height={600} alt="Stoneware" priority />),
    );

    expect(out).toContain('fetchpriority="high"');
    expect(out).not.toContain("loading=");
    expect(out).toContain('decoding="async"');
  });

  test("srcset and sizes pass through", () => {
    const out = html(
      <Image
        src="/a.jpg"
        width={800}
        height={600}
        alt=""
        srcset="/a-400.jpg 400w, /a-800.jpg 800w"
        sizes="(min-width: 60rem) 800px, 100vw"
      />,
    );

    expect(out).toContain('srcset="/a-400.jpg 400w, /a-800.jpg 800w"');
    expect(out).toContain('sizes="(min-width: 60rem) 800px, 100vw"');
  });

  test("unknown attributes are passed through", () => {
    const out = html(
      <Image src="/a.jpg" width={10} height={10} alt="" class="rounded" data-test="x" />,
    );

    expect(out).toContain('class="rounded"');
    expect(out).toContain('data-test="x"');
  });

  test("alt is escaped like any other value", () => {
    const out = html(<Image src="/a.jpg" width={10} height={10} alt={'"><script>'} />);

    expect(out).not.toContain("<script>");
  });
});

describe("preloading a priority image", () => {
  test("contributes a link tag to the head", () => {
    const preloads = inRender((collected) => {
      html(<Image src="/hero.jpg" width={1200} height={600} alt="" priority />);
      return collected;
    });

    expect([...preloads]).toEqual(['<link rel="preload" as="image" href="/hero.jpg">']);
  });

  test("carries srcset and sizes so the preloader picks the same candidate", () => {
    // Without these the preload downloads one file and the <img> downloads
    // another - strictly worse than not preloading at all.
    const preloads = inRender((collected) => {
      html(
        <Image
          src="/hero.jpg"
          width={1200}
          height={600}
          alt=""
          priority
          srcset="/hero-600.jpg 600w"
          sizes="100vw"
        />,
      );
      return collected;
    });

    const tag = [...preloads][0]!;
    expect(tag).toContain('imagesrcset="/hero-600.jpg 600w"');
    expect(tag).toContain('imagesizes="100vw"');
  });

  test("the same image twice preloads once", () => {
    const preloads = inRender((collected) => {
      html(
        <div>
          <Image src="/hero.jpg" width={10} height={10} alt="" priority />
          <Image src="/hero.jpg" width={10} height={10} alt="" priority />
        </div>,
      );
      return collected;
    });

    expect(preloads.size).toBe(1);
  });

  test("a non-priority image preloads nothing", () => {
    const preloads = inRender((collected) => {
      html(<Image src="/a.jpg" width={10} height={10} alt="" />);
      return collected;
    });

    expect(preloads.size).toBe(0);
  });

  test("the tag lands in <head>, ahead of the stylesheet", () => {
    const rendered = renderToString(<p>body</p>);
    const doc = buildDocument({
      html: rendered.html,
      islands: rendered.islands,
      manifest: {},
      preloads: ['<link rel="preload" as="image" href="/hero.jpg">'],
      stylesheet: "/_stoneware/styles-abc.css",
    });

    const head = doc.slice(0, doc.indexOf("</head>"));
    expect(head).toContain('rel="preload"');
    expect(head.indexOf("preload")).toBeLessThan(head.indexOf("stylesheet"));
  });

  test("renders without a request context instead of throwing", () => {
    // renderToString is usable standalone - in a test, or on a fragment.
    expect(() => html(<Image src="/a.jpg" width={10} height={10} alt="" priority />)).not.toThrow();
  });
});

describe("what it refuses", () => {
  test("a missing alt names the decorative escape hatch", () => {
    // @ts-expect-error - alt is required
    expect(() => html(<Image src="/a.jpg" width={10} height={10} />)).toThrow(/alt=""/);
  });

  test("a missing or zero dimension is an error", () => {
    // @ts-expect-error - height is required
    expect(() => html(<Image src="/a.jpg" width={10} alt="" />)).toThrow(/positive height/);
    expect(() => html(<Image src="/a.jpg" width={0} height={10} alt="" />)).toThrow(
      /positive width/,
    );
  });

  test("sizes without srcset is an error, because it does nothing", () => {
    expect(() => html(<Image src="/a.jpg" width={10} height={10} alt="" sizes="100vw" />)).toThrow(
      /sizes but no srcset/,
    );
  });
});
