/**
 * Token access for templates that need to hand a CSRF token to an island.
 *
 * `<Form>` covers the ordinary case on its own. This is for the case where an
 * island performs its own `fetch()`: the island re-renders itself in the
 * browser, so it needs the token as an ordinary prop.
 */

import { generateToken } from "./csrf.ts";
import { getRenderContext } from "./context.ts";

/** Mint a CSRF token for the request currently being rendered. */
export function csrfToken(): string {
  const { config } = getRenderContext();
  return generateToken(config);
}

/** Name of the field/header the server checks, so islands can stay in sync. */
export function csrfFieldName(): string {
  return getRenderContext().config.csrf.fieldName;
}
