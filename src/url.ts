/**
 * The public URL of a request.
 *
 * `new URL(request.url)` is the internal one. Every platform that terminates
 * TLS - Render, Railway, Fly, Heroku, Vercel, nginx - forwards a plain HTTP
 * request to the app, so that URL says `http://` for a site served over
 * `https://`. Anything absolute the app builds from it then points at the
 * insecure origin: canonical links, `og:image`, OAuth redirects, sitemaps.
 *
 * The forwarded headers that describe the original request are also trivially
 * forged by anyone who can reach the app directly, which is why honouring them
 * is a decision the project makes rather than a default.
 */

const FORWARDED_PROTO = "x-forwarded-proto";
const FORWARDED_HOST = "x-forwarded-host";

export function requestURL(request: Request, trustProxy: boolean | "proto"): URL {
  const url = new URL(request.url);
  if (trustProxy === false) return url;

  const proto = firstValue(request.headers.get(FORWARDED_PROTO));
  if (proto === "http" || proto === "https") url.protocol = `${proto}:`;

  // The host is the dangerous half. A forged `X-Forwarded-Host` poisons every
  // absolute URL the app emits - password-reset links, canonical tags, anything
  // cached downstream - so it needs the stronger opt-in, not "proto".
  if (trustProxy === true) {
    const host = firstValue(request.headers.get(FORWARDED_HOST));
    if (host !== undefined && isPlausibleHost(host)) {
      // Assigning `host` without a port leaves the previous one in place, so a
      // forwarded `example.com` on a server listening on 3000 would produce
      // `https://example.com:3000` - an internal port baked into every public
      // URL. Clear it first and let the forwarded value supply its own.
      url.port = "";
      url.host = host;
    }
  }

  return url;
}

/**
 * Take the first entry of a comma-separated forwarded header.
 *
 * Each proxy in a chain appends its own value, so `X-Forwarded-Proto` arrives as
 * `https, http` when a second hop is plain. The first entry is the one the
 * client actually spoke.
 */
function firstValue(header: string | null): string | undefined {
  if (header === null) return undefined;
  const first = header.split(",")[0]?.trim();
  return first === undefined || first === "" ? undefined : first;
}

/**
 * Reject a host that could not have come from a real request.
 *
 * Assigning to `url.host` silently ignores some malformed values and accepts
 * others, so a header carrying a path, a scheme or whitespace would either do
 * nothing or produce a URL nobody intended. Checking first keeps the failure
 * mode "the forwarded host was ignored" rather than something stranger.
 */
function isPlausibleHost(host: string): boolean {
  return /^[a-zA-Z0-9.\-[\]]+(:\d{1,5})?$/.test(host);
}
