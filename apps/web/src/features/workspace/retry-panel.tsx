"use client";

import { Button } from "@solyn/ui/components/button";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

export default function RetryPanel({ retry }: { retry?: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <section className="surface status-panel" aria-labelledby="unavailable-heading">
      <h1 id="unavailable-heading">Your workspace is unavailable</h1>
      <p>
        We could not load this page. Check your connection and try again. No save has been attempted
        by this page.
      </p>
      <div className="inline-actions">
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
        <Link href="/login" className="text-link">
          Back to sign in
        </Link>
      </div>
    </section>
  );
}
