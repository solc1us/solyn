import Link from "next/link";

export default function WorkspaceNotFound() {
  return (
    <div className="page-content">
      <section className="surface status-panel">
        <h1>Nothing here</h1>
        <p>This item does not exist, or it is not available to your account.</p>
        <Link href="/projects" className="primary-link">
          Back to projects
        </Link>
      </section>
    </div>
  );
}
