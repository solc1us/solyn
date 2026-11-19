"use client";

import RetryPanel from "@/features/workspace/retry-panel";

export default function ApplicationError({ retry }: { retry: () => void }) {
  return (
    <main className="standalone-page mx-auto w-[min(740px,100%)] px-[24px] py-[12vh]">
      <RetryPanel retry={retry} />
    </main>
  );
}
