/** A route that renders a database row straight into markup. */
const ROW = { id: 7, title: "Widget", price: 9.99 };

function Price({ product }: { product: unknown }) {
  return <span>{product as never}</span>;
}

export default function Home() {
  return <main><Price product={ROW} /></main>;
}
