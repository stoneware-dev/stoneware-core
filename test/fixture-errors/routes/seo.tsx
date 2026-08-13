import type { PageProps } from "../../../src/router.ts";
import { Image } from "../../../src/image.tsx";
import { seo } from "../../../src/seo.tsx";

/** Contributes to <head> without the page owning the whole document. */
export function head({ url }: PageProps) {
  return (
    <>
      {seo({
        title: "Custom title",
        description: "From the head export",
        canonical: `https://example.com${url.pathname}`,
        openGraph: { image: "/images/card.png", siteName: "Fixture" },
        x: { site: "@stoneware" },
        robots: { index: true, follow: true },
        jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: "Custom title" },
      })}
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
