/**
 * Behavior functions live outside the templates (CLAUDE.md §2.2).
 *
 * In a real site this would query a database or read a content directory; the
 * shape is what matters — templates receive plain data and do no fetching.
 */

export interface Post {
  slug: string;
  title: string;
  date: string;
  summary: string;
  paragraphs: string[];
}

const POSTS: Post[] = [
  {
    slug: "server-first",
    title: "Why server-first, again",
    date: "2026-02-11",
    summary: "Most pages are documents. Shipping a runtime to render a document is a strange default.",
    paragraphs: [
      "A marketing page, a blog post, and a docs page have something in common: the interesting content is known before the request finishes. Rendering it on the server is not a performance trick, it is just doing the work where the data already is.",
      "The interactive parts are real, but they are small and they are local — a counter, a signup form, a menu. Those deserve JavaScript. The other 95% of the page does not.",
    ],
  },
  {
    slug: "islands",
    title: "Islands, and where the boundary goes",
    date: "2026-03-02",
    summary: "The useful question is not whether to hydrate, but what the unit of hydration is.",
    paragraphs: [
      "An island is a subtree that owns its own interactivity. Everything outside it stays inert HTML forever, which means it costs nothing to send and nothing to run.",
      "Kiln draws the boundary at the directory level. A file in islands/ hydrates; a file in routes/ never does. There is no per-file directive to forget and no way to accidentally make a page interactive.",
    ],
  },
  {
    slug: "escaping",
    title: "Escaping should be the path of least resistance",
    date: "2026-04-19",
    summary: "Safe-by-default only means something if unsafe requires typing more.",
    paragraphs: [
      "Every value interpolated into a Kiln template goes through Bun.escapeHTML(). Not by convention, not by lint rule — by the renderer, with no way to switch it off globally.",
      "Emitting unescaped markup requires wrapping the value in raw(). That is deliberately more effort than the safe path, and it is greppable during review.",
    ],
  },
];

export function listPosts(): Post[] {
  return [...POSTS].sort((a, b) => b.date.localeCompare(a.date));
}

export function getPost(slug: string): Post | undefined {
  return POSTS.find((post) => post.slug === slug);
}
