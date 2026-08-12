import { raw } from "sinter";
import type { PageProps } from "sinter";

/** No islands: this page must ship zero JavaScript. */
export default function Plain(_props: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Plain page</title>
      </head>
      <body>
        <h1>Plain page</h1>
        <p>{"<script>alert(1)</script>"}</p>
        <p>{raw("<em>trusted</em>")}</p>
      </body>
    </html>
  );
}
