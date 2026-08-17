/** An error page with the same bug, so the two failures must be told apart. */
const CONFIG = { theme: "dark", locale: "en" };

function Banner() {
  return <p>{CONFIG as never}</p>;
}

export default function ServerError() {
  return <html lang="en"><body><Banner /></body></html>;
}
