import type { ErrorPageProps } from "../../../src/router.ts";

export default function NotFound({ url, status }: ErrorPageProps) {
  return (
    <html lang="en">
      <head>
        <title>Nothing here</title>
      </head>
      <body>
        <h1>Custom {status}</h1>
        <p>No page at {url.pathname}</p>
      </body>
    </html>
  );
}
