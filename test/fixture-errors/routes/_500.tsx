import type { ErrorPageProps } from "../../../src/routing/router.ts";

export default function ServerError({ status, message, error }: ErrorPageProps) {
  return (
    <html lang="en">
      <head>
        <title>Broken</title>
      </head>
      <body>
        <h1>Custom {status}</h1>
        <p>{message}</p>
        {/* Present in dev only, so the tests can assert both halves. */}
        {error ? <pre>{String(error)}</pre> : null}
      </body>
    </html>
  );
}
