"use client";

import RetryPanel from "@/features/workspace/retry-panel";

export default function WorkspaceError({ retry }: { retry: () => void }) {
  return (
    <div className="page-content">
      <RetryPanel retry={retry} />
    </div>
  );
}
