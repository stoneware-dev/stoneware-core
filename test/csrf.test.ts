/**
 * CSRF verification logic (CLAUDE.md §15).
 *
 * The behavioral claim under test is that verification is a property of the
 * request pipeline, not something a route opts into.
 */

import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config.ts";
import { generateToken, isSafeMethod, verifyRequest } from "../src/http/csrf.ts";

const config = resolveConfig({ csrf: { secret: "unit-test-secret-value-0123456789" } }, false);

function formRequest(fields: Record<string, string>, method = "POST"): Request {
  const body = new URLSearchParams(fields);
  return new Request("http://localhost/api/thing", {
    method,
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

describe("safe methods", () => {
  test("GET, HEAD, and OPTIONS need no token", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isSafeMethod(method)).toBe(true);
    }
  });

  test("mutating methods are not exempt", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isSafeMethod(method)).toBe(false);
    }
  });

  test("a GET request passes without a token", async () => {
    const request = new Request("http://localhost/", { method: "GET" });
    expect((await verifyRequest(request, config)).ok).toBe(true);
  });
});

describe("verification", () => {
  test("accepts a token from the hidden form field", async () => {
    const request = formRequest({ _csrf: generateToken(config), email: "a@b.com" });
    expect((await verifyRequest(request, config)).ok).toBe(true);
  });

  test("accepts a token from the header, for fetch-based islands", async () => {
    const request = new Request("http://localhost/api/thing", {
      method: "POST",
      headers: { "x-csrf-token": generateToken(config), "Content-Type": "application/json" },
      body: "{}",
    });
    expect((await verifyRequest(request, config)).ok).toBe(true);
  });

  test("rejects a missing token", async () => {
    const result = await verifyRequest(formRequest({ email: "a@b.com" }), config);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Missing CSRF token/);
  });

  test("rejects a forged token", async () => {
    const result = await verifyRequest(formRequest({ _csrf: "not-a-real-token" }), config);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/Invalid or expired/);
  });

  test("rejects a token signed with a different secret", async () => {
    const other = resolveConfig({ csrf: { secret: "a-completely-different-secret-99" } }, false);
    const result = await verifyRequest(formRequest({ _csrf: generateToken(other) }), config);
    expect(result.ok).toBe(false);
  });

  test("rejects an expired token", async () => {
    const shortLived = resolveConfig(
      { csrf: { secret: config.csrf.secret, expiresIn: 1 } },
      false,
    );
    const token = generateToken(shortLived);
    await Bun.sleep(20);
    expect((await verifyRequest(formRequest({ _csrf: token }), shortLived)).ok).toBe(false);
  });

  test("leaves the request body readable by the handler", async () => {
    const request = formRequest({ _csrf: generateToken(config), email: "a@b.com" });
    expect((await verifyRequest(request, config)).ok).toBe(true);

    // The pipeline verifies against a clone, so the handler still gets a body.
    expect(request.bodyUsed).toBe(false);
    const form = await request.formData();
    expect(form.get("email")).toBe("a@b.com");
  });
});

describe("configuration", () => {
  test("a production build refuses to start without a secret", () => {
    const previous = Bun.env.STONEWARE_CSRF_SECRET;
    delete process.env.STONEWARE_CSRF_SECRET;
    try {
      expect(() => resolveConfig({}, false)).toThrow(/No CSRF secret configured/);
    } finally {
      if (previous !== undefined) process.env.STONEWARE_CSRF_SECRET = previous;
    }
  });
});
