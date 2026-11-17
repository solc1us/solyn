"use client";

import RetryPanel from "@/features/workspace/retry-panel";

export default function ApplicationError({ retry }: { retry: () => void }) {
  return (
    <main className="standalone-page">
      <RetryPanel retry={retry} />
    </main>
  );
}
