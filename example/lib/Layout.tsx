/**
 * A layout is just a function that returns markup — no base class, no special
 * export, no framework registration. It lives in lib/ because it is shared, not
 * because the framework requires it to.
 */

import type { Child } from "kiln";

export interface LayoutProps {
  title: string;
  children?: Child;
}

export function Layout({ title, children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <header class="site-header">
          <a class="brand" href="/">
            kiln
          </a>
          <nav>
            <a href="/">Posts</a>
            <a href="/about">About</a>
          </nav>
        </header>
        <main>{children}</main>
        <footer class="site-footer">
          <p>Rendered on the server. The only JavaScript on this page is its islands.</p>
        </footer>
      </body>
    </html>
  );
}
