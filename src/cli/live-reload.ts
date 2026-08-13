/**
 * Dev-only live-reload client.
 *
 * Served as a real file rather than inlined into the page so the default CSP
 * still applies in development. If `script-src 'self'` had to be relaxed for the
 * dev server, developers would be testing against a policy their production
 * site does not use - which is exactly how CSP violations reach production.
 *
 * It also reports build failures. Without that, a rebuild that fails leaves the
 * browser showing stale output with no sign anything went wrong, and the only
 * clue is a line in a terminal that may not even be visible.
 */

const SOCKET_PATH = "/_stoneware/live-reload";
const OVERLAY_ID = "stoneware-error-overlay";

function connect(): void {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}${SOCKET_PATH}`);

  socket.addEventListener("message", (event) => {
    const data = String(event.data);

    if (data === "reload") {
      location.reload();
      return;
    }

    if (data.startsWith("error:")) {
      showOverlay(data.slice("error:".length));
    }
  });

  // The server going away usually means it is restarting; poll until it answers.
  socket.addEventListener("close", () => {
    setTimeout(connect, 500);
  });
}

/**
 * Styles are set through the CSSOM rather than a stylesheet or a `style`
 * attribute. `style-src 'self'` forbids inline styles, but assigning to
 * `element.style` is a DOM operation that CSP does not govern - the same
 * technique islands use to drive a value at runtime.
 */
function showOverlay(message: string): void {
  document.getElementById(OVERLAY_ID)?.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483647",
    padding: "2rem",
    overflow: "auto",
    background: "rgba(12, 14, 13, 0.94)",
    color: "#e8eae9",
    font: "13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace",
  });

  const heading = document.createElement("p");
  heading.textContent = "Build failed";
  Object.assign(heading.style, {
    margin: "0 0 1rem",
    color: "#ff9a8c",
    font: "600 14px/1.4 ui-sans-serif, system-ui, sans-serif",
    letterSpacing: "0.02em",
  });

  // textContent, never innerHTML: the message is a compiler error containing
  // arbitrary source, and this overlay is not a place to start parsing markup.
  const body = document.createElement("pre");
  body.textContent = message;
  Object.assign(body.style, { margin: "0", whiteSpace: "pre-wrap", wordBreak: "break-word" });

  const hint = document.createElement("p");
  hint.textContent = "This overlay clears when the next build succeeds.";
  Object.assign(hint.style, { marginTop: "1.5rem", opacity: "0.6" });

  overlay.append(heading, body, hint);
  document.body.appendChild(overlay);
}

connect();
