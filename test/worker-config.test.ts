/**
 * How the worker count gets into the config.
 *
 * Four ways in — the default, `WEB_CONCURRENCY`, the config file, and the CLI
 * flag (which writes `WEB_CONCURRENCY`) — and the one that matters most is the
 * default, because it decides what every project that never thinks about this
 * gets. That is one process, and these tests exist so it stays one process.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveConfig } from "../src/config.ts";

const SECRET = "worker-config-test-secret";

let saved: string | undefined;

beforeEach(() => {
  saved = Bun.env.WEB_CONCURRENCY;
  delete Bun.env.WEB_CONCURRENCY;
});

afterEach(() => {
  if (saved === undefined) delete Bun.env.WEB_CONCURRENCY;
  else Bun.env.WEB_CONCURRENCY = saved;
});

const resolve = (config = {}, dev = false) =>
  resolveConfig({ csrf: { secret: SECRET }, ...config }, dev);

describe("the default", () => {
  test("is one process", () => {
    expect(resolve().workers).toBe(1);
  });

  test("is one process in development too", () => {
    expect(resolve({}, true).workers).toBe(1);
  });
});

describe("the config file", () => {
  test("an explicit count is carried through", () => {
    expect(resolve({ workers: 4 }).workers).toBe(4);
  });

  test('"auto" is carried through for serve() to resolve', () => {
    // Left as the string on purpose: how many cores there are is a question for
    // the machine that runs the server, not the machine that wrote the config.
    expect(resolve({ workers: "auto" }).workers).toBe("auto");
  });
});

describe("WEB_CONCURRENCY", () => {
  test("is read when the config says nothing", () => {
    // Heroku, Render and Railway already set this to say how many processes a
    // plan's memory allows, so a plan change scales the app with no code edit.
    Bun.env.WEB_CONCURRENCY = "6";
    expect(resolve().workers).toBe(6);
  });

  test("loses to an explicit config setting", () => {
    Bun.env.WEB_CONCURRENCY = "6";
    expect(resolve({ workers: 2 }).workers).toBe(2);
  });

  for (const value of ["0", "-1", "banana", "2.5", ""]) {
    test(`${JSON.stringify(value)} is ignored rather than fatal`, () => {
      // It comes from a platform, not from the project. Refusing to boot
      // because a host set something odd would trade a working single process
      // for an outage.
      Bun.env.WEB_CONCURRENCY = value;
      expect(resolve().workers).toBe(1);
    });
  }
});
