/**
 * Starting a server when the port might be busy.
 *
 * The interesting case is not two servers fighting over the same socket - that
 * raises EADDRINUSE and always did. It is two servers on the *same port* that
 * never collide because they bound different addresses: `stoneware dev` binds
 * localhost, `stoneware start` binds 0.0.0.0, and those are separate sockets.
 * Both processes then report success while requests go to whichever one the
 * client's IPv4/IPv6 preference picks.
 *
 * That is why dev asks whether anything *answers* before binding, rather than
 * only reacting to a failed bind. Production keeps the opposite rule: bind the
 * assigned port or fail saying so.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { listen } from "../src/listen.ts";

// High and arbitrary, to stay clear of anything the developer is running.
let next = 4940;
const openPort = () => next++;

const started: { stop(force?: boolean): void }[] = [];

function track<T extends { stop(force?: boolean): void }>(server: T): T {
  started.push(server);
  return server;
}

afterEach(() => {
  while (started.length > 0) started.pop()?.stop(true);
});

describe("development", () => {
  test("moves to the next port when the same address is taken", async () => {
    const port = openPort();
    track(await listen({ port, hostname: "127.0.0.1", fetch: () => new Response("first") }));

    const second = track(
      await listen({
        port,
        hostname: "127.0.0.1",
        fetch: () => new Response("second"),
        allowPortFallback: true,
      }),
    );

    expect(second.port).toBe(port + 1);
  });

  test("moves when the port is held on a different address", async () => {
    // The regression this file exists for. A 0.0.0.0 listener and a localhost
    // listener do not conflict at the socket level, so nothing throws and the
    // old bind-failure check saw a free port.
    const port = openPort();
    track(
      Bun.serve({ port, hostname: "0.0.0.0", fetch: () => new Response("all interfaces") }),
    );

    const dev = track(
      await listen({
        port,
        hostname: "localhost",
        fetch: () => new Response("dev"),
        allowPortFallback: true,
      }),
    );

    expect(dev.port).toBe(port + 1);
  });

  test("the server it moved past keeps answering", async () => {
    const port = openPort();
    track(Bun.serve({ port, hostname: "0.0.0.0", fetch: () => new Response("squatter") }));

    const dev = track(
      await listen({
        port,
        hostname: "localhost",
        fetch: () => new Response("dev"),
        allowPortFallback: true,
      }),
    );

    // Both are serving, on the ports each actually holds.
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("squatter");
    expect(await (await fetch(`http://localhost:${dev.port}/`)).text()).toBe("dev");
  });

  test("takes the requested port when nothing is there", async () => {
    const port = openPort();
    const server = track(
      await listen({
        port,
        hostname: "127.0.0.1",
        fetch: () => new Response("only"),
        allowPortFallback: true,
      }),
    );

    expect(server.port).toBe(port);
  });
});

describe("production", () => {
  test("refuses a taken port rather than moving", async () => {
    // A platform routes traffic to the port it assigned. Binding a different one
    // yields a service that looks healthy in its own logs while every external
    // request fails, which is worse than not starting.
    const port = openPort();
    track(await listen({ port, hostname: "0.0.0.0", fetch: () => new Response("first") }));

    expect(
      listen({ port, hostname: "0.0.0.0", fetch: () => new Response("second") }),
    ).rejects.toThrow(/EADDRINUSE|in use/i);
  });

  test("does not probe, so a busy neighbour is still a hard failure", async () => {
    const port = openPort();
    track(Bun.serve({ port, hostname: "0.0.0.0", fetch: () => new Response("neighbour") }));

    expect(
      listen({ port, hostname: "0.0.0.0", fetch: () => new Response("prod") }),
    ).rejects.toThrow();
  });
});

describe("reusePort", () => {
  test("cannot be combined with allowPortFallback", async () => {
    // They want opposite things when the port is busy: fallback moves to the
    // next port, reusePort deliberately shares the one it was given. Silently
    // picking one would make a clustered server bind a different port per
    // worker and look like it was working.
    expect(
      listen({
        port: openPort(),
        hostname: "127.0.0.1",
        fetch: () => new Response("x"),
        allowPortFallback: true,
        reusePort: true,
      }),
    ).rejects.toThrow(/cannot both be set/i);
  });

  test("is passed through to Bun.serve", async () => {
    // Whether it load-balances is the kernel's business and Linux-only; that
    // this reaches the socket at all is the framework's.
    const port = openPort();
    const server = track(
      await listen({
        port,
        hostname: "127.0.0.1",
        fetch: () => new Response("shared"),
        reusePort: true,
      }),
    );

    expect(server.port).toBe(port);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toBe("shared");
  });

  test("each option is still fine on its own", async () => {
    const fallback = track(
      await listen({
        port: openPort(),
        hostname: "127.0.0.1",
        fetch: () => new Response("a"),
        allowPortFallback: true,
      }),
    );
    expect(fallback.port).toBeGreaterThan(0);
  });
});
