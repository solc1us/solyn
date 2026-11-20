import type { Route } from "next";
import Link from "next/link";

import type { UiMessage } from "./client-state";

export function RetrievedNotes({
  message,
}: {
  message: Pick<UiMessage, "role" | "status" | "persisted" | "proposal" | "sources">;
}) {
  if (
    message.role !== "assistant" ||
    message.status !== "completed" ||
    !message.persisted ||
    message.proposal ||
    !message.sources?.length
  )
    return null;
  return (
    <section aria-label="Retrieved notes" className="mt-[14px] text-[13px]">
      <h3 className="mb-[4px] font-medium">Retrieved notes</h3>
      <ol className="m-0 list-inside list-decimal space-y-[4px] p-0">
        {message.sources.map((source) => (
          <li key={source.ordinal}>
            {source.state === "available" ? (
              <Link
                href={source.href as Route}
                prefetch={false}
                className="underline underline-offset-4"
              >
                {source.title}
              </Link>
            ) : (
              <span className="text-muted-foreground">Note unavailable</span>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-[6px] text-[12px] text-muted-foreground">
        Links open current note versions, not saved snapshots.
      </p>
    </section>
  );
}
