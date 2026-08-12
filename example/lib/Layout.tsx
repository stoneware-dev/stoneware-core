/**
 * The site shell.
 *
 * A layout is just a function that returns markup - no base class, no special
 * export, no registration. It lives in lib/ because it is shared, not because
 * the framework demands it.
 */

import type { Child } from "stoneware";
import FiringGauge from "../islands/FiringGauge.tsx";

export interface LayoutProps {
  title: string;
  description: string;
  /** Highlights the matching top-level nav entry. */
  section?: "docs" | "home";
  children?: Child;
}

export function Layout({ title, description, section = "home", children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta name="color-scheme" content="dark light" />
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>

        <header class="masthead">
          <a class="wordmark" href="/">
            stoneware
          </a>
          <nav>
            <a href="/" aria-current={section === "home" ? "page" : undefined}>
              Overview
            </a>
            <a href="/docs" aria-current={section === "docs" ? "page" : undefined}>
              Docs
            </a>
            <a href="/docs/quick-start">Quick start</a>
          </nav>
        </header>

        <FiringGauge />

        <main id="main">{children}</main>

        <footer class="shell colophon">
          <span>
            Rendered on the server by stoneware. This page runs under the framework's default
            Content-Security-Policy, unmodified.
          </span>
          <span>
            <a href="/docs">Documentation</a> · <a href="/docs/security">Security</a> · MIT
          </span>
        </footer>
      </body>
    </html>
  );
}
