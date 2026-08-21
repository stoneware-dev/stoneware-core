import { seo } from "../../../src/helpers/seo.tsx";

/** Owns its whole document, so seo() inside its own <head> is legitimate. */
export default function FullDocument() {
  return (
    <html lang="en">
      <head>{seo({ title: "Full document" })}</head>
      <body>
        <p>body</p>
      </body>
    </html>
  );
}
