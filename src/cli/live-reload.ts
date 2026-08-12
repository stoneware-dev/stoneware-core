/**
 * Dev-only live-reload client.
 *
 * Served as a real file rather than inlined into the page so the default CSP
 * still applies in development. If `script-src 'self'` had to be relaxed for the
 * dev server, developers would be testing against a policy their production
 * site does not use - which is exactly how CSP violations reach production.
 */

const SOCKET_PATH = "/_stoneware/live-reload";

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}${SOCKET_PATH}`);

  socket.addEventListener("message", (event) => {
    if (event.data === "reload") location.reload();
  });

  // The server going away usually means it is restarting; poll until it answers.
  socket.addEventListener("close", () => {
    setTimeout(connect, 500);
  });
}

connect();
