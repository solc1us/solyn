"use client";

import { Button, buttonVariants } from "@solyn/ui/components/button";
import { cn } from "@solyn/ui/lib/utils";
import { FileText, FolderClosed, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { listNotes, listProjects } from "./actions";
import type { ErrorCode } from "./contracts";
import {
  appendUnique,
  formatDate,
  projectRow,
  noteRow,
  type CollectionRow,
  type NoteSummary,
  type Project,
} from "./presentation";

export default function Collection({
  initial,
  projectId,
}: {
  initial: CollectionRow[];
  projectId?: string;
}) {
  const [rows, setRows] = useState(initial);
  const [offset, setOffset] = useState(initial.length);
  const [hasMore, setHasMore] = useState(initial.length === 50);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const noun = projectId ? "notes" : "projects";
  const Icon = projectId ? FileText : FolderClosed;

  async function loadMore() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = projectId
        ? await listNotes({ projectId, limit: 50, offset })
        : await listProjects({ limit: 50, offset });
      if (!result.ok) {
        setError(result.error.code);
        return;
      }
      const page = projectId
        ? (result.data as NoteSummary[]).map(noteRow)
        : (result.data as Project[]).map(projectRow);
      setRows((current) => appendUnique(current, page));
      setOffset(offset + result.data.length);
      setHasMore(result.data.length === 50);
    } catch {
      setError("UNAVAILABLE");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-label={projectId ? "Project notes" : "Your projects"}
      className="collection overflow-clip"
    >
      {rows.length ? (
        <ul className="collection-list m-0 list-none p-0">
          {rows.map((row) => (
            <li
              key={row.id}
              className="[content-visibility:auto] [contain-intrinsic-size:auto_60px]"
            >
              <Link
                className="collection-row grid min-h-[48px] grid-cols-[20px_minmax(0,1fr)_auto_16px] items-center gap-[12px] rounded-[7px] px-[12px] py-[10px] transition-[background-color] duration-[120ms] ease-[ease] [&:hover]:bg-(--hover) [@media(max-width:760px)]:grid-cols-[20px_minmax(0,1fr)_16px] [@media(max-width:760px)]:gap-x-[10px] [@media(max-width:760px)]:gap-y-[2px] [@media(max-width:760px)]:px-[8px]"
                href={projectId ? `/projects/${projectId}/notes/${row.id}` : `/projects/${row.id}`}
              >
                <span className="item-icon grid h-[24px] w-[20px] place-items-center text-muted-foreground [@media(max-width:760px)]:row-[1/3]">
                  <Icon size={19} aria-hidden="true" />
                </span>
                <div className="item-copy min-w-0">
                  <span className="item-title block text-[14px] font-[550] [overflow-wrap:anywhere]">
                    {row.title}
                  </span>
                  {row.description ? (
                    <p className="mt-[2px] truncate text-[13px] text-muted-foreground">
                      {row.description}
                    </p>
                  ) : null}
                  {row.noteDate ? (
                    <p className="mt-[2px] truncate text-[13px] text-muted-foreground">
                      Note date: {formatDate(row.noteDate)}
                    </p>
                  ) : null}
                </div>
                <time
                  className="text-[12px] whitespace-nowrap text-muted-foreground tabular-nums [@media(max-width:760px)]:col-start-2 [@media(max-width:760px)]:row-start-2"
                  dateTime={new Date(row.updatedAt).toISOString()}
                >
                  <span className="sr-only">Last edited </span>
                  {formatDate(row.updatedAt)}
                </time>
                <ChevronRight
                  size={16}
                  className="row-chevron text-muted-foreground [@media(max-width:760px)]:col-start-3 [@media(max-width:760px)]:row-[1/3]"
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state mx-auto max-w-[520px] px-[30px] py-[72px] text-center [@media(max-width:760px)]:px-[22px] [@media(max-width:760px)]:py-[48px]">
          <Icon size={28} className="mx-auto mb-[16px] text-muted-foreground" aria-hidden="true" />
          <p className="leading-[1.75] text-muted-foreground">
            {projectId ? "No notes yet." : "No projects yet."}
          </p>
          <Link
            href={projectId ? `/projects/${projectId}/notes/new` : "/projects/new"}
            className={cn(buttonVariants(), "mt-[16px] bg-clip-border select-auto")}
          >
            {projectId ? "New note" : "New project"}
          </Link>
        </div>
      )}
      {error ? (
        <div className="collection-feedback px-[24px] py-[16px] text-destructive" role="alert">
          <p>
            {error === "UNAUTHENTICATED"
              ? "Your session has ended."
              : error === "NOT_FOUND"
                ? "This project is no longer available."
                : "Could not load more items. Your current list is unchanged."}
          </p>
          {error === "UNAUTHENTICATED" ? (
            <Link href="/login" className="underline">
              Sign in
            </Link>
          ) : null}
        </div>
      ) : null}
      <footer className="collection-footer flex min-h-[48px] items-center justify-between gap-[16px] px-[12px] py-[16px] [@media(max-width:760px)]:flex-wrap [@media(max-width:760px)]:px-[16px] [@media(max-width:760px)]:py-[14px]">
        <span role="status" className="text-[12px] text-muted-foreground">
          {rows.length} {noun} loaded
        </span>
        {hasMore && offset <= 100_000 ? (
          <Button className="control" variant="secondary" disabled={pending} onClick={loadMore}>
            {pending ? "Loading…" : `Load more ${noun}`}
          </Button>
        ) : null}
        {hasMore && offset > 100_000 ? (
          <p>The workspace pagination limit has been reached.</p>
        ) : null}
      </footer>
    </section>
  );
}
