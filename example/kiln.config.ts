import { defineConfig } from "kiln";

export default defineConfig({
  port: 3000,
  // No csp override: the framework's default policy applies. Overriding it is
  // possible here, omitting it entirely is not.
  csrf: {
    // Bun loads .env automatically, so KILN_CSRF_SECRET is picked up with no
    // dotenv dependency. The literal fallback exists only so this example runs
    // straight from a clone — a real app should let the missing-secret error
    // fire rather than hardcode one.
    secret: Bun.env.KILN_CSRF_SECRET ?? "example-only-secret-do-not-use-in-production",
  },
});
