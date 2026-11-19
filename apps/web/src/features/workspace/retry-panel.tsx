"use client";

import { Button } from "@solyn/ui/components/button";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export default function RetryPanel({ retry }: { retry?: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <section
      className="status-panel rounded-[12px] border border-border bg-canvas p-[40px] [.workspace-main_&]:rounded-none [.workspace-main_&]:border-0 [.workspace-main_&]:bg-transparent [@media(max-width:760px)]:px-[22px] [@media(max-width:760px)]:py-[28px]"
      aria-labelledby="unavailable-heading"
    >
      <h1 id="unavailable-heading">Your workspace is unavailable</h1>
      <p className="mt-[16px] mb-[26px] text-muted-foreground">
        We could not load this page. Check your connection and try again. No save has been attempted
        by this page.
      </p>
      <div className="flex flex-wrap items-center gap-[8px]">
        <Button
          className="control"
          disabled={pending}
          onClick={() =>
            startTransition(() => {
              if (retry) retry();
              else router.refresh();
            })
          }
        >
          {pending ? "Loading…" : "Try loading again"}
        </Button>
        <Link href="/login" className="text-[#b2c7ff] [&:hover]:underline">
          Back to sign in
        </Link>
      </div>
    </section>
  );
}
