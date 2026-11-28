"use client";

import { Button } from "@solyn/ui/components/button";
import { Label } from "@solyn/ui/components/label";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { listNotes, listProjects } from "./actions";
import { appendUnique, type NoteSummary } from "./presentation";
import { taskSelectClass } from "./task-state";

export type ProjectChoice = { id: string; name: string };
export function ProjectSelect({
  initial,
  selected,
  value,
  onChange,
  disabled,
  all = false,
  invalid = false,
}: {
  initial: ProjectChoice[];
  selected?: ProjectChoice;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  all?: boolean;
  invalid?: boolean;
}) {
  const [rows, setRows] = useState(initial);
  const [offset, setOffset] = useState(initial.length);
  const [more, setMore] = useState(initial.length === 50);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const busy = useRef(false);
  const options = selected ? appendUnique(rows, [selected]) : rows;
  async function loadMore() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const result = await listProjects({ limit: 50, offset });
      if (!result.ok) {
        setError(true);
        return;
      }
      setRows((current) => appendUnique(current, result.data));
      setOffset(offset + result.data.length);
      setMore(result.data.length === 50);
    } catch {
      setError(true);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div className="grid min-w-0 gap-[6px]">
      <Label htmlFor="task-project">Project{all ? "" : " (required)"}</Label>
      <select
        id="task-project"
        name="projectId"
        className={taskSelectClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        required={!all}
        aria-invalid={invalid}
        aria-describedby={invalid ? "task-projectId-error" : undefined}
      >
        <option value="">{all ? "All projects" : "Select project"}</option>
        {options.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          Could not load projects. Check your session and try again.
        </p>
      ) : null}
      {more && offset <= 100_000 ? (
        <Button
          type="button"
          variant="secondary"
          className="justify-self-start"
          disabled={disabled || pending}
          onClick={loadMore}
        >
          {pending ? "Loading…" : error ? "Retry projects" : "Load more projects"}
        </Button>
      ) : null}
      {more && offset > 100_000 ? (
        <p className="text-[12px] text-muted-foreground">Project pagination limit reached.</p>
      ) : null}
    </div>
  );
}

export function SourceNoteSelect({
  projectId,
  value,
  onChange,
  initialSource,
  disabled,
  invalid = false,
}: {
  projectId: string;
  value: string;
  onChange: (value: string) => void;
  initialSource?: { id: string; title: string };
  disabled: boolean;
  invalid?: boolean;
}) {
  const [rows, setRows] = useState<NoteSummary[]>([]);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const active = useRef(true);
  const busy = useRef(false);
  const source =
    rows.find((note) => note.id === value) ??
    (initialSource?.id === value ? initialSource : undefined);
  async function load(start: number) {
    if (!projectId || busy.current) return;
    busy.current = true;
    setPending(true);
    setError(false);
    try {
      const result = await listNotes({ projectId, limit: 50, offset: start });
      if (!active.current) return;
      if (!result.ok) {
        setError(true);
        return;
      }
      setRows((current) => (start === 0 ? result.data : appendUnique(current, result.data)));
      setOffset(start + result.data.length);
      setMore(result.data.length === 50);
    } catch {
      if (active.current) setError(true);
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void load(0);
    return () => {
      active.current = false;
    };
    // This picker is keyed by project in TaskEditor; a scope change discards old reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="grid gap-[6px]">
      <Label htmlFor="task-source">Source note</Label>
      <select
        id="task-source"
        name="sourceNoteId"
        className={taskSelectClass}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || !projectId}
        aria-invalid={invalid}
        aria-describedby={invalid ? "task-sourceNoteId-error" : undefined}
      >
        <option value="">No source note</option>
        {value && !rows.some((note) => note.id === value) ? (
          <option value={value}>
            {source?.title ?? "Current source note (not in loaded notes)"}
          </option>
        ) : null}
        {rows.map((note) => (
          <option key={note.id} value={note.id}>
            {note.title}
          </option>
        ))}
      </select>
      {source ? (
        <Link
          className="w-fit text-[13px] underline"
          href={`/projects/${projectId}/notes/${source.id}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open source note
        </Link>
      ) : null}
      {pending ? (
        <p role="status" className="text-[13px] text-muted-foreground">
          Loading notes…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          Could not load source notes. Your selection is unchanged.
        </p>
      ) : null}
      {(error || more) && offset <= 100_000 ? (
        <Button
          type="button"
          className="justify-self-start"
          variant="secondary"
          disabled={disabled || pending}
          onClick={() => load(offset)}
        >
          {error ? "Retry notes" : "Load more notes"}
        </Button>
      ) : null}
      {more && offset > 100_000 ? (
        <p className="text-[12px] text-muted-foreground">Note pagination limit reached.</p>
      ) : null}
    </div>
  );
}
