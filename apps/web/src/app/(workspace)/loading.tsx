export default function LoadingWorkspace() {
  return (
    <div
      className="page-content px-[24px] pt-[20px] pb-[40px] [@media(max-width:760px)]:[padding:20px_max(16px,env(safe-area-inset-right))_max(40px,env(safe-area-inset-bottom))_max(16px,env(safe-area-inset-left))]"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">Loading workspace…</span>
      <div
        className="loading-heading mb-[38px] h-[20px] w-[160px] rounded-[5px] bg-button"
        aria-hidden="true"
      />
      <div
        className="loading-surface rounded-[12px] border border-border bg-canvas p-[24px] [.workspace-main_&]:border-0 [.workspace-main_&]:bg-transparent"
        aria-hidden="true"
      >
        <div className="my-[12px] h-[50px] rounded-[6px] bg-secondary" />
        <div className="my-[12px] h-[50px] rounded-[6px] bg-secondary" />
        <div className="my-[12px] h-[50px] rounded-[6px] bg-secondary" />
      </div>
    </div>
  );
}
