/** Links to a page that exists, one that never will, and an asset. */
export default function Home() {
  return (
    <main>
      <a href="/about">about — exists</a>
      <a href="/items/first">a dynamic route with no staticPaths</a>
      <a href="/items/second">the same route, another id</a>
      <a href="/nowhere">a route that does not exist at all</a>
      <a href="/about?ref=nav#top">query and fragment must not confuse it</a>
      <a href="https://example.com/x">external, not ours to check</a>
      <a href="#section">a bare fragment</a>
      <img src="/logo.svg" alt="" />
      <img src="/missing.png" alt="" />
    </main>
  );
}
