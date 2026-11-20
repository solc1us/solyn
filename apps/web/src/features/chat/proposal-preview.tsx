"use client";

import { Button } from "@solyn/ui/components/button";
import { Input } from "@solyn/ui/components/input";
import { Label } from "@solyn/ui/components/label";
import { Textarea } from "@solyn/ui/components/textarea";
import Link from "next/link";
import { useState } from "react";

import type { listProposalProjects } from "./actions";
import {
  originalProposalEdit,
  proposalEditDirty,
  type ProposalEdit,
  type ProposalSave,
} from "./client-state";
import { confirmNoteProposalInput, type ProposalView } from "./contracts";
import { issueMessages, safeIssue, type Issue } from "./transport";

export function ProposalPreview({
  proposal,
  edit,
  change,
  loadProjects,
  saveState,
  save,
  recover,
}: {
  proposal: ProposalView;
  edit?: ProposalEdit;
  change: (patch: Partial<ProposalEdit>) => void;
  loadProjects: typeof listProposalProjects;
  saveState?: ProposalSave;
  save?: () => void;
  recover?: () => void;
}) {
  const locked = !!saveState && saveState.phase !== "error";
  const value = locked
    ? { ...saveState.payload, noteDate: saveState.payload.noteDate ?? "" }
    : (edit ?? originalProposalEdit(proposal));
  const dirty = proposalEditDirty(proposal, edit);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<Issue | null>(null);
  async function load(pageOffset = offset) {
    if (busy) return;
    setBusy(true);
    setIssue(null);
    try {
      const result = await loadProjects({ limit: 50, offset: pageOffset });
      if (!result.ok) setIssue(safeIssue(result.error.code));
      else {
        // A page of owned choices is never interpreted as unique name resolution.
        setProjects(result.data);
        setLoaded(true);
        setOffset(pageOffset + result.data.length);
        setHasMore(result.data.length === 50 && pageOffset < 100_000);
      }
    } catch {
      setIssue("UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  const valid = confirmNoteProposalInput.safeParse({
    proposalId: proposal.id,
    projectId: value.projectId,
    title: value.title,
    content: value.content,
    noteDate: value.noteDate || null,
  });
  const prefix = `proposal-${proposal.id}`;
  if (proposal.status === "confirmed" && proposal.receipt)
    return (
      <section
        className="mt-[16px] rounded-[7px] border border-border p-[16px]"
        aria-label="Confirmed note"
      >
        <p>Note saved.</p>
        <Link
          href={`/projects/${proposal.receipt.projectId}/notes/${proposal.receipt.noteId}`}
          className="underline"
        >
          Open saved note
        </Link>
      </section>
    );
  return (
    <form
      className="mt-[16px] grid gap-[12px] rounded-[7px] border border-border bg-canvas p-[16px]"
      aria-label="Note draft preview"
      data-unsaved={dirty || locked ? "true" : "false"}
      onSubmit={(event) => event.preventDefault()}
    >
      <div>
        <h3 className="text-[15px] font-medium">
          {locked ? "Note draft — save status unconfirmed" : "Note draft — not saved as a note"}
        </h3>
        <p className="text-[12px] text-muted-foreground">
          Source:{" "}
          {proposal.scopedProject
            ? `project chat · ${proposal.scopedProject.name}`
            : "general chat"}
          .
        </p>
        <p className="mt-[4px] text-[12px] text-muted-foreground">
          The original draft is saved in chat. Edits stay local; reload restores the original draft.
          Save note explicitly to create the project note.
        </p>
      </div>
      {proposal.scopedProject ? (
        <p className="text-[14px]">Project: {proposal.scopedProject.name}</p>
      ) : (
        <div className="grid gap-[6px]">
          <Label htmlFor={`${prefix}-project`}>Project (required before saving)</Label>
          <select
            id={`${prefix}-project`}
            className="min-h-[36px] w-full rounded-[7px] border border-input bg-canvas px-[10px] text-[14px]"
            value={value.projectId}
            disabled={locked}
            onChange={(event) => change({ projectId: event.target.value })}
          >
            <option value="">Select a project explicitly</option>
            {value.projectId && !projects.some((p) => p.id === value.projectId) ? (
              <option value={value.projectId}>Previously selected project (local)</option>
            ) : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          {proposal.draft.projectHint ? (
            <p className="text-[12px] text-muted-foreground">
              Suggested name: {proposal.draft.projectHint}. This does not select a project.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-[8px]">
            <Button
              type="button"
              variant="secondary"
              disabled={locked || busy || (loaded && !hasMore)}
              onClick={() => load()}
            >
              {busy
                ? "Loading projects…"
                : !loaded
                  ? "Load my projects"
                  : hasMore
                    ? "Next project choices"
                    : "No more project choices"}
            </Button>
            {loaded ? (
              <Button
                type="button"
                variant="secondary"
                disabled={locked || busy || offset - projects.length === 0}
                onClick={() => load(Math.max(0, offset - projects.length - 50))}
              >
                Previous project choices
              </Button>
            ) : null}
          </div>
          {loaded && !projects.length ? (
            <p role="status" className="text-[12px] text-muted-foreground">
              No more owned projects found.
            </p>
          ) : null}
          {!value.projectId ? (
            <p className="text-[12px] text-muted-foreground">No project selected.</p>
          ) : null}
          {issue ? (
            <p role="alert" className="text-[13px] text-destructive">
              {issueMessages[issue]}{" "}
              {issue === "UNAUTHENTICATED" ? (
                <Link href="/login" target="_blank" rel="noopener noreferrer" className="underline">
                  Sign in in a new tab
                </Link>
              ) : null}
            </p>
          ) : null}
        </div>
      )}
      <div className="grid gap-[6px]">
        <Label htmlFor={`${prefix}-title`}>Title</Label>
        <Input
          id={`${prefix}-title`}
          value={value.title}
          disabled={locked}
          maxLength={300}
          onChange={(event) => change({ title: event.target.value })}
        />
      </div>
      <div className="grid gap-[6px]">
        <Label htmlFor={`${prefix}-content`}>Content</Label>
        <Textarea
          id={`${prefix}-content`}
          className="min-h-[160px] resize-y"
          rows={6}
          value={value.content}
          disabled={locked}
          maxLength={100_000}
          onChange={(event) => change({ content: event.target.value })}
        />
      </div>
      <div className="grid gap-[6px]">
        <Label htmlFor={`${prefix}-date`}>Note date (optional)</Label>
        <Input
          id={`${prefix}-date`}
          type="date"
          min="0001-01-01"
          max="9999-12-31"
          value={value.noteDate}
          disabled={locked}
          onChange={(event) => change({ noteDate: event.target.value })}
        />
        <p className="text-[12px] text-muted-foreground">
          Leave blank if the historical date is unknown.
        </p>
      </div>
      {!valid.success && (value.projectId || proposal.scopedProject) ? (
        <p role="alert" className="text-[13px] text-destructive">
          Check the title, nonblank content and calendar date. Text cannot contain invalid Unicode
          or NUL.
        </p>
      ) : null}
      {saveState ? (
        <div role="status" className="text-[13px]">
          {saveState.phase === "saving"
            ? "Saving note…"
            : saveState.phase === "checking"
              ? "Save unconfirmed — checking saved status…"
              : saveState.phase === "retry"
                ? "Save unconfirmed. Not confirmed by the last read; retry only the same submitted fields."
                : saveState.phase === "uncertain"
                  ? "Save unconfirmed. Check saved status before retrying."
                  : "The note save was not completed."}
          {saveState.issue ? (
            <p role="alert">
              {issueMessages[saveState.issue]}{" "}
              {saveState.issue === "UNAUTHENTICATED" ? (
                <Link href="/login" target="_blank" rel="noopener noreferrer" className="underline">
                  Sign in in a new tab
                </Link>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-[8px]">
        {saveState?.phase !== "uncertain" ? (
          <Button
            type="button"
            disabled={!save || !valid.success || (locked && saveState?.phase !== "retry")}
            onClick={save}
          >
            {saveState?.phase === "saving"
              ? "Saving note…"
              : saveState?.phase === "retry"
                ? "Retry same save"
                : "Save note"}
          </Button>
        ) : null}
        {saveState && saveState.phase !== "saving" ? (
          <Button
            type="button"
            variant="secondary"
            disabled={!recover || saveState.phase === "checking"}
            onClick={recover}
          >
            Check saved status
          </Button>
        ) : null}
      </div>
      <p role="status" className="text-[12px] text-muted-foreground">
        {saveState
          ? "Submitted fields retained locally; check saved status before changing or retrying an uncertain save."
          : dirty
            ? "Local changes — not saved. Reload will discard these edits."
            : "Original persisted draft. No note has been created."}
      </p>
    </form>
  );
}
