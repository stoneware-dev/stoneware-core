import { csrfFieldName, csrfToken } from "kiln";
import type { PageProps } from "kiln";
import { Layout } from "../lib/Layout.tsx";
import { listPosts } from "../lib/posts.ts";
import Counter from "../islands/Counter.tsx";
import Newsletter from "../islands/Newsletter.tsx";
import SubscriberBadge from "../islands/SubscriberBadge.tsx";

export default function Home(_props: PageProps) {
  const posts = listPosts();

  return (
    <Layout title="kiln — a Bun-native SSR framework">
      <section class="intro">
        <h1>Server-rendered by default</h1>
        <p>
          Everything on this page is HTML the server produced. The three islands below are the only
          JavaScript that ships.
        </p>
        <SubscriberBadge />
      </section>

      <section class="posts">
        <h2>Posts</h2>
        <ul>
          {posts.map((post) => (
            <li key={post.slug}>
              <a href={`/blog/${post.slug}`}>{post.title}</a>
              <time datetime={post.date}>{post.date}</time>
              <p>{post.summary}</p>
            </li>
          ))}
        </ul>
      </section>

      <section class="demo">
        <h2>Islands</h2>
        <p>
          This button is an island: it was server-rendered as static HTML, then hydrated with its own
          signal.
        </p>
        <Counter />
      </section>

      <section class="signup">
        <Newsletter token={csrfToken()} fieldName={csrfFieldName()} />
      </section>
    </Layout>
  );
}
