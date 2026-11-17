"use client";

import { Button } from "@solyn/ui/components/button";
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
      className="collection surface"
    >
      <div className="collection-heading">
        <span>{projectId ? "Note" : "Project"}</span>
        <span>Last edited</span>
      </div>
      {rows.length ? (
        <ul className="collection-list">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                className="collection-row"
                href={projectId ? `/projects/${projectId}/notes/${row.id}` : `/projects/${row.id}`}
              >
                <span className="item-icon">
                  <Icon size={19} aria-hidden="true" />
                </span>
                <div className="item-copy">
                  <span className="item-title">{row.title}</span>
                  {row.description ? <p>{row.description}</p> : null}
                  {row.noteDate ? <p>Note date: {formatDate(row.noteDate)}</p> : null}
                </div>
                <time dateTime={new Date(row.updatedAt).toISOString()}>
                  {formatDate(row.updatedAt)}
                </time>
                <ChevronRight size={16} className="row-chevron" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state">
          <Icon size={28} aria-hidden="true" />
          <h2>{projectId ? "Start with a note" : "Make room for your next project"}</h2>
          <p>
            {projectId
              ? "Capture a discussion, a decision, or something worth remembering. Create your first note to get started."
              : "Keep the context, decisions, and notes for each project together. Create your first project to begin."}
          </p>
        </div>
      )}
      {error ? (
        <div className="collection-feedback" role="alert">
          <p>
            {error === "UNAUTHENTICATED"
              ? "Your session has ended."
              : error === "NOT_FOUND"
                ? "This project is no longer available."
                : "Could not load more items. Your current list is unchanged."}
          </p>
          {error === "UNAUTHENTICATED" ? <Link href="/login">Sign in</Link> : null}
        </div>
      ) : null}
      <footer className="collection-footer">
        <span role="status">
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
