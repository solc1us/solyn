import Link from "next/link";

export default function NotFound() {
  return (
    <main className="standalone-page">
      <section className="surface status-panel">
        <h1>Nothing here</h1>
        <p>This page does not exist, or the item is not available to your account.</p>
        <Link href="/dashboard" className="primary-link">
          Back to workspace
        </Link>
      </section>
    </main>
  );
}
