import { defineConfig } from "stoneware";

export default defineConfig({
  port: 3000,
  // No csp override: the framework's default policy applies. This site is the
  // proof that the strict default is livable - if a page here needed an
  // exception, that would be a bug in the framework, not in the page.
  csrf: {
    // Bun loads .env automatically, so STONEWARE_CSRF_SECRET is picked up with no
    // dotenv dependency. The literal fallback exists only so the docs site runs
    // straight from a clone.
    secret: Bun.env.STONEWARE_CSRF_SECRET ?? "docs-site-only-secret-not-for-production",
  },
});
