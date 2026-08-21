/**
 * The `<Form>` helper.
 *
 * Stoneware apps use this instead of a raw `<form>` so the CSRF token is injected
 * without anyone having to remember it (CLAUDE.md §9). The server verifies the
 * token on the way back in regardless, so a raw `<form>` does not silently skip
 * protection - it simply fails.
 */

import { generateToken } from "./csrf.ts";
import { getRenderContext, markPersonalized } from "./context.ts";
import { isSafeMethod } from "./csrf.ts";
import type { Child } from "./types.ts";

export interface FormProps {
  /** Route to submit to, e.g. `/api/subscribe`. */
  action: string;
  /** Defaults to POST - the whole point of this helper is mutating requests. */
  method?: "POST" | "PUT" | "PATCH" | "DELETE" | "GET" | "post" | "get";
  children?: Child;
  [attribute: string]: unknown;
}

export function Form({ action, method = "POST", children, ...rest }: FormProps) {
  // A GET form does not mutate state and is not verified, so adding a token
  // would only leak it into the query string.
  if (isSafeMethod(method)) {
    return (
      <form action={action} method={method} {...rest}>
        {children}
      </form>
    );
  }

  const { config } = getRenderContext();
  markPersonalized();
  const token = generateToken(config);

  // HTML forms can only issue GET and POST. PUT/PATCH/DELETE are tunnelled
  // through POST with an override field, which the router unwraps.
  const overridden = method.toUpperCase() !== "POST";

  return (
    <form action={action} method="POST" {...rest}>
      <input type="hidden" name={config.csrf.fieldName} value={token} />
      {overridden && <input type="hidden" name="_method" value={method.toUpperCase()} />}
      {children}
    </form>
  );
}
