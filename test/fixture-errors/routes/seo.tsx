import type { PageProps } from "../../../src/router.ts";
import { Image } from "../../../src/image.tsx";

/** Contributes to <head> without the page owning the whole document. */
export function head({ url }: PageProps) {
  return (
    <>
      <title>Custom title</title>
      <meta name="description" content="From the head export" />
      <link rel="canonical" href={`https://example.com${url.pathname}`} />
    </>
  );
}

export default function Seo() {
  return (
    <main>
      <Image src="/hero.jpg" width={1200} height={600} alt="Hero" priority />
      <Image src="/later.jpg" width={800} height={500} alt="Later" />
    </main>
  );
}
