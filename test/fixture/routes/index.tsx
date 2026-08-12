import { Form, csrfToken } from "kiln";
import type { PageProps } from "kiln";
import Badge from "../islands/Badge.tsx";
import Counter from "../islands/Counter.tsx";

export default function Home(_props: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Fixture home</title>
        <link rel="stylesheet" href="/styles.css" />
      </head>
      <body>
        <h1>Fixture home</h1>
        <Badge />
        <Counter />
        <Form action="/api/echo">
          <input type="text" name="message" />
          <button type="submit">Send</button>
        </Form>
        <p data-token-length={String(csrfToken().length > 0)}>token issued</p>
      </body>
    </html>
  );
}
