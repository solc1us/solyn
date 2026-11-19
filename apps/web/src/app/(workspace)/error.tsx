"use client";

import RetryPanel from "@/features/workspace/retry-panel";

export default function WorkspaceError({ retry }: { retry: () => void }) {
  return (
    <div className="page-content px-[24px] pt-[20px] pb-[40px] [@media(max-width:760px)]:[padding:20px_max(16px,env(safe-area-inset-right))_max(40px,env(safe-area-inset-bottom))_max(16px,env(safe-area-inset-left))]">
      <RetryPanel retry={retry} />
    </div>
  );
}
