/**
 * Renders documentation blocks.
 *
 * A plain function over plain data — the same shape as every other template.
 */

import { CodeBlock } from "./highlight.tsx";
import type { Block } from "./docs.ts";

export function Prose({ blocks }: { blocks: Block[] }) {
  return (
    <div class="prose">
      {blocks.map((block) => {
        switch (block.kind) {
          case "h2":
            return <h2>{block.text}</h2>;

          case "code":
            return (
              <CodeBlock
                code={block.text ?? ""}
                language={block.language ?? "tsx"}
                label={block.label}
              />
            );

          case "list":
            return (
              <ul>
                {(block.items ?? []).map((item) => (
                  <li>{item}</li>
                ))}
              </ul>
            );

          case "quote":
            return <blockquote>{block.text}</blockquote>;

          // Diagrams are monospace text, not images: they stay legible at any
          // zoom, survive copy/paste, need no alt text beyond their caption,
          // and cost nothing to load.
          case "figure":
            return (
              <figure class="figure">
                <pre>{block.text}</pre>
                {block.label && <figcaption>{block.label}</figcaption>}
              </figure>
            );

          default:
            return <p>{block.text}</p>;
        }
      })}
    </div>
  );
}
