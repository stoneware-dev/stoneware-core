import type { PageProps } from "kiln";
import { Layout } from "../../lib/Layout.tsx";
import { getPost } from "../../lib/posts.ts";

export default function BlogPost({ params }: PageProps) {
  const post = getPost(params.slug!);

  if (!post) {
    return (
      <Layout title="Not found">
        <article class="post">
          <h1>No such post</h1>
          <p>
            Nothing is published at <code>{params.slug}</code>.
          </p>
          <p>
            <a href="/">Back to all posts</a>
          </p>
        </article>
      </Layout>
    );
  }

  return (
    <Layout title={post.title}>
      <article class="post">
        <h1>{post.title}</h1>
        <time datetime={post.date}>{post.date}</time>
        {post.paragraphs.map((paragraph) => (
          <p>{paragraph}</p>
        ))}
        <p>
          <a href="/">Back to all posts</a>
        </p>
      </article>
    </Layout>
  );
}
