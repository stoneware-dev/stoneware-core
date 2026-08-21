/**
 * The two ways a full-document route used to fail without saying anything.
 *
 * Both were found by rendering fixtures through buildDocument and diffing the
 * output, not by reading the code — which is the point. A route that renders
 * its own <html> with no <head> lost its stylesheet and its entire head()
 * export, and a route whose <html> sat behind a comment was wrapped in a second
 * document. Neither produced any output at all.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { buildDocument, resetDocumentWarnings } from "../src/render/document.ts";

const BASE = {
  islands: [],
  manifest: {} as Record<string, string>,
  stylesheet: "/_stoneware/styles-abc.css",
  head: '<title>Real</title><link rel="canonical" href="https://example.com/x">',
  preloads: ['<link rel="preload" as="image" href="/hero.avif">'],
};

/** Capture console.warn for one call. */
function capture(fn: () => string): { output: string; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    return { output: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

afterEach(() => resetDocumentWarnings());

describe("a full document with a head", () => {
  test("still receives everything", () => {
    const { output, warnings } = capture(() =>
      buildDocument({
        ...BASE,
        html: '<html lang="en"><head><meta charset="utf-8"></head><body><main>Hi</main></body></html>',
        route: "/ok",
      }),
    );

    expect(output).toContain("styles-abc.css");
    expect(output).toContain("Real");
    expect(output).toContain("canonical");
    expect(output).toContain("hero.avif");
    expect(warnings).toHaveLength(0);
  });
});

describe("a full document with no head", () => {
  const html = '<html lang="en"><body><main>Hi</main></body></html>';

  test("names the route and everything that was dropped", () => {
    const { warnings } = capture(() =>
      buildDocument({ ...BASE, html, route: "/articles/[slug]" }),
    );

    expect(warnings).toHaveLength(1);
    const message = warnings[0];
    expect(message).toContain("/articles/[slug]");
    expect(message).toContain("<head>");
    expect(message).toContain("stylesheet");
    expect(message).toContain("head()");
    expect(message).toContain("preload");
  });

  test("warns in production too, because the page is live and broken", () => {
    // The consequence is a deployed page with no CSS and no metadata. The
    // person who needs to know is the one running it.
    const { warnings } = capture(() => buildDocument({ ...BASE, html, route: "/x", dev: false }));
    expect(warnings).toHaveLength(1);
  });

  test("warns once per route, not once per request", () => {
    const { warnings } = capture(() => {
      buildDocument({ ...BASE, html, route: "/repeated" });
      buildDocument({ ...BASE, html, route: "/repeated" });
      buildDocument({ ...BASE, html, route: "/repeated" });
      return "";
    });

    expect(warnings).toHaveLength(1);
  });

  test("says nothing when there was nothing to inject", () => {
    // A bare document with no CSS and no head() export is a legitimate thing to
    // return, and warning about it would be noise.
    const { warnings } = capture(() =>
      buildDocument({
        islands: [],
        manifest: {},
        html,
        route: "/bare",
        stylesheet: null,
      }),
    );

    expect(warnings).toHaveLength(0);
  });

  test("island scripts are still injected", () => {
    // The body is intact even when the head is not, so interactivity should not
    // also break.
    const { output } = capture(() =>
      buildDocument({
        ...BASE,
        html,
        route: "/islands",
        suffix: "<!--marker-->",
      }),
    );

    expect(output).toContain("<!--marker-->");
  });
});

describe("a document whose <html> is not first", () => {
  const html = '<!-- generated --><html lang="en"><head></head><body><main>Hi</main></body></html>';

  test("warns in dev that it is about to be nested", () => {
    const { output, warnings } = capture(() =>
      buildDocument({ ...BASE, html, route: "/commented", dev: true }),
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("/commented");
    expect(warnings[0]).toContain("nested");

    // The behaviour is unchanged — this is a diagnostic, not a repair. Changing
    // the output would be a breaking change for anyone relying on the wrap.
    expect((output.match(/<html/gi) ?? []).length).toBe(2);
  });

  test("stays quiet for an ordinary fragment", () => {
    const { warnings } = capture(() =>
      buildDocument({ ...BASE, html: "<main>Hi</main>", route: "/fragment", dev: true }),
    );

    expect(warnings).toHaveLength(0);
  });

  test("does not pay for the check in production", () => {
    const { warnings } = capture(() =>
      buildDocument({ ...BASE, html, route: "/prod", dev: false }),
    );

    expect(warnings).toHaveLength(0);
  });
});
