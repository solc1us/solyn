export default function LoadingWorkspace() {
  return (
    <div className="page-content" role="status" aria-busy="true">
      <span className="sr-only">Loading workspace…</span>
      <div className="loading-heading" aria-hidden="true" />
      <div className="surface loading-surface" aria-hidden="true">
        <div />
        <div />
        <div />
      </div>
    </div>
  );
}
