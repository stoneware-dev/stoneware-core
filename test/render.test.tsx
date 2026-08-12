/**
 * Template compiler / renderer unit tests (CLAUDE.md §15).
 *
 * The escaping cases are the ones that matter most: they are the difference
 * between "safe by default" being a design goal and being a property.
 */

import { describe, expect, test } from "bun:test";
import { signal } from "@preact/signals-core";
import { raw } from "../src/escape.ts";
import { renderToString } from "../src/render.ts";
import { h } from "../src/jsx-runtime.ts";

const html = (tree: Parameters<typeof renderToString>[0]) => renderToString(tree).html;

describe("elements", () => {
  test("renders a tag with attributes and text", () => {
    expect(html(<p class="lead">hello</p>)).toBe(`<p class="lead">hello</p>`);
  });

  test("omits false and nullish attributes, bare-renders true ones", () => {
    expect(html(<input disabled={false} required={true} name={null} value={undefined} />)).toBe(
      `<input required>`,
    );
  });

  test("maps className and htmlFor to their HTML names", () => {
    expect(html(<label className="a" htmlFor="b" />)).toBe(`<label class="a" for="b"></label>`);
  });

  test("void elements get no closing tag", () => {
    expect(html(<br />)).toBe("<br>");
    expect(html(<img src="/a.png" />)).toBe(`<img src="/a.png">`);
  });

  test("void elements reject children", () => {
    expect(() => html(h("br", null, "nope"))).toThrow(/void element/);
  });

  test("serializes style objects, adding px only where it is valid", () => {
    expect(html(<div style={{ marginTop: 4, opacity: 1, zIndex: 3, color: "red" }} />)).toBe(
      `<div style="margin-top:4px;opacity:1;z-index:3;color:red;"></div>`,
    );
  });

  test("drops event handlers, which mean nothing without an island", () => {
    expect(html(<button onClick={() => {}}>x</button>)).toBe("<button>x</button>");
  });
});

describe("children", () => {
  test("renders arrays, numbers, and skips nullish/boolean", () => {
    expect(html(<p>{[1, "a", null, undefined, false, true]}</p>)).toBe("<p>1a</p>");
  });

  test("renders fragments without a wrapper element", () => {
    expect(html(<><b>a</b><i>b</i></>)).toBe("<b>a</b><i>b</i>");
  });

  test("calls plain component functions once", () => {
    let calls = 0;
    const Widget = ({ n }: { n: number }) => {
      calls++;
      return <span>{n}</span>;
    };
    expect(html(<Widget n={7} />)).toBe("<span>7</span>");
    expect(calls).toBe(1);
  });

  test("reads a signal's current value", () => {
    const count = signal(41);
    expect(html(<p>{count}</p>)).toBe("<p>41</p>");
    count.value = 42;
    expect(html(<p>{count}</p>)).toBe("<p>42</p>");
  });
});

describe("escaping", () => {
  test("escapes interpolated text", () => {
    expect(html(<p>{'<script>alert(1)</script>'}</p>)).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  test("escapes attribute values, including quote breakouts", () => {
    expect(html(<a title={'" onmouseover="alert(1)'}>x</a>)).toBe(
      `<a title="&quot; onmouseover=&quot;alert(1)">x</a>`,
    );
  });

  test("escapes values coming through a component's props", () => {
    const Title = ({ text }: { text: string }) => <h1>{text}</h1>;
    expect(html(<Title text={'<img src=x onerror=alert(1)>'} />)).toBe(
      "<h1>&lt;img src=x onerror=alert(1)&gt;</h1>",
    );
  });

  test("raw() is the only way through", () => {
    expect(html(<p>{raw("<em>ok</em>")}</p>)).toBe("<p><em>ok</em></p>");
  });

  test("raw() rejects non-strings", () => {
    expect(() => raw(123 as unknown as string)).toThrow(TypeError);
  });

  test("rejects attribute names that could break out of the tag", () => {
    expect(() => html(h("div", { 'x="y" onload': "1" }))).toThrow(/Invalid attribute name/);
  });

  test("refuses to interpolate dynamic values into <script>", () => {
    const userInput = "1";
    expect(() => html(<script>{userInput}</script>)).not.toThrow(); // literal string is allowed
    expect(() => html(<script>{{ toString: () => "x" } as never}</script>)).toThrow(
      /only contain literal strings/,
    );
  });

  test("refuses script content that would close the tag early", () => {
    expect(() => html(<script>{"var a = '</script>'"}</script>)).toThrow(/would terminate/);
  });
});
