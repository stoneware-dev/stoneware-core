/**
 * A scroll-linked firing gauge.
 *
 * Reads scroll position into a signal and writes it to `--heat` on the document
 * root. Everything visual — the rail fill, the gradient under the masthead — is
 * derived from that one custom property in styles.css.
 *
 * The write goes through `style.setProperty`, i.e. the CSSOM, which CSP does not
 * govern. Rendering a `style=""` attribute instead would be blocked outright by
 * the framework's default `style-src 'self'`.
 */

import { computed, signal } from "stoneware/signals";

/** 0 at the top of the document, 1 at the bottom. */
const heat = signal(0);

/** Bisque fire starts near room temperature; cone 10 vitrifies at ~1285 °C. */
const temperature = computed(() => Math.round(20 + heat.value * 1265));

let tracking = false;

function track(): void {
  // The module also loads on the server during SSR, where none of this exists.
  if (typeof window === "undefined" || tracking) return;
  tracking = true;

  const update = () => {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const next = scrollable > 0 ? window.scrollY / scrollable : 0;
    heat.value = Math.min(1, Math.max(0, next));
    document.documentElement.style.setProperty("--heat", String(heat.value.toFixed(4)));
  };

  addEventListener("scroll", update, { passive: true });
  addEventListener("resize", update, { passive: true });
  update();
}

export default function FiringGauge() {
  track();

  return (
    <aside class="gauge" aria-hidden="true">
      <div class="gauge__track">
        <div class="gauge__fill" />
      </div>
      <span class="gauge__readout">
        <b>{temperature}</b> °C
      </span>
    </aside>
  );
}
