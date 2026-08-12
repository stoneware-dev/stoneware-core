import type { PageProps } from "kiln";

export default function Entry({ params }: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <title>Entry</title>
      </head>
      <body>
        <h1>Entry: {params.slug}</h1>
      </body>
    </html>
  );
}
