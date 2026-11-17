import Link from "next/link";

export default function Home() {
  return (
    <main className="space-y-4 p-6">
      <h1>Solyn</h1>
      <p>The custom workspace interface is not available yet.</p>
      <Link href="/dashboard">Continue to workspace</Link>
    </main>
  );
}
