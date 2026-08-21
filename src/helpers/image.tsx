/**
 * `<Image>` - correct image markup, with nothing to install.
 *
 * Stoneware does not resize, re-encode, or compress anything: Bun ships no image
 * codec, and pulling in a native one would mean a platform-specific binary and
 * roughly thirty times the install size for a framework whose entire dependency
 * list is one 4 kB package (CLAUDE.md §2.6). Bring your own pipeline, or ship
 * the files you have.
 *
 * What it does do is the part that actually moves Core Web Vitals and that
 * hand-written `<img>` tags get wrong: reserved space, off-screen deferral, and
 * a real priority signal for the one image that matters.
 */

import { addPreload } from "../http/context.ts";
import { escapeHTML } from "../render/escape.ts";
import { h } from "../jsx-runtime.ts";
import type { VNode } from "../render/types.ts";

export interface ImageProps {
  src: string;
  /**
   * Intrinsic width and height in pixels. Required, and deliberately so: the
   * ratio is what lets the browser reserve space before the bytes arrive, and
   * a missing one is the single largest cause of layout shift. CSS can still
   * size the element however it likes.
   */
  width: number;
  height: number;
  /**
   * Alternative text. `alt=""` is a valid, meaningful answer - it marks the
   * image as decorative - but it has to be written, not forgotten.
   */
  alt: string;
  /**
   * The one image worth loading before anything else, typically the LCP
   * element. Loads eagerly, at high priority, with a `<link rel="preload">` in
   * the head so the browser can start before it reaches this tag.
   *
   * Marking several images priority means marking none of them: the point is to
   * rank one ahead of the rest.
   */
  priority?: boolean;
  srcset?: string;
  sizes?: string;
  class?: string;
  id?: string;
  title?: string;
  /** Passed through, e.g. `crossorigin` or a `data-*` hook. */
  [attribute: string]: unknown;
}

export function Image(props: ImageProps): VNode {
  const { src, width, height, alt, priority, srcset, sizes, ...rest } = props;

  assertValid(props);

  if (priority) {
    // Emitted into <head>, where it can start the download before the parser
    // has reached the <img> itself. `imagesrcset`/`imagesizes` let the
    // preloader pick the same candidate the img will, instead of racing it to
    // a different one and downloading two files.
    addPreload(preloadTag({ src, srcset, sizes }));
  }

  return h("img", {
    ...rest,
    src,
    width,
    height,
    alt,
    ...(srcset === undefined ? {} : { srcset }),
    ...(sizes === undefined ? {} : { sizes }),
    // A priority image must not be lazy: the two are contradictory, and
    // `loading="lazy"` on an LCP image measurably delays it.
    ...(priority ? { fetchpriority: "high" } : { loading: "lazy" }),
    // Always async: decoding off the main thread costs nothing and keeps a
    // large image from blocking the first paint of everything around it.
    decoding: "async",
  });
}

function assertValid(props: ImageProps): void {
  const { src, width, height, alt, sizes, srcset } = props;

  if (typeof alt !== "string") {
    throw new Error(
      `<Image src="${src}"> is missing alt. Write alt="" if the image is decorative — ` +
        `that is a real answer, and it has to be a deliberate one.`,
    );
  }

  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `<Image src="${src}"> needs a positive ${name} in pixels. ` +
          `The intrinsic size is what reserves space before the image loads; ` +
          `without it the page shifts when it arrives.`,
      );
    }
  }

  // `sizes` describes how wide the image will be rendered, which only means
  // something when there are candidates to choose between.
  if (sizes !== undefined && srcset === undefined) {
    throw new Error(
      `<Image src="${src}"> has sizes but no srcset. ` +
        `sizes tells the browser which srcset candidate to pick, so alone it does nothing.`,
    );
  }
}

function preloadTag(options: { src: string; srcset?: string; sizes?: string }): string {
  let tag = `<link rel="preload" as="image" href="${escapeHTML(options.src)}"`;
  if (options.srcset !== undefined) tag += ` imagesrcset="${escapeHTML(options.srcset)}"`;
  if (options.sizes !== undefined) tag += ` imagesizes="${escapeHTML(options.sizes)}"`;
  return tag + ">";
}

export default Image;
