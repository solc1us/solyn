"use client";

import { Button } from "@solyn/ui/components/button";
import { Input } from "@solyn/ui/components/input";
import { Label } from "@solyn/ui/components/label";
import { Textarea } from "@solyn/ui/components/textarea";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { listProposalProjects } from "./actions";
import { type ManagementProposalView, managementTaskFields } from "./management-contracts";
import {
  managementEditDirty,
  managementPayload,
  originalManagementEdit,
  type ManagementEdit,
  type ManagementSave,
} from "./management-client";
import { fieldErrors } from "../workspace/presentation";
import { FieldError } from "../workspace/feedback";
import { issueMessages, safeIssue, type Issue } from "./transport";
import type { SourceView } from "./contracts";

const selectClass =
  "form-control min-h-[36px] w-full min-w-0 rounded-[7px] border border-input bg-canvas px-[10px] text-[16px] focus:border-ring";
function ProjectChoices({
  id,
  value,
  change,
  disabled,
  loadProjects,
}: {
  id: string;
  value: string;
  change: (value: string) => void;
  disabled: boolean;
  loadProjects: typeof listProposalProjects;
}) {
  const [rows, setRows] = useState<{ id: string; name: string }[]>([]);
  const [offset, setOffset] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<Issue | null>(null);
  const pending = useRef(false),
    active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function load(start: number) {
    if (pending.current || start < 0 || start > 100_000) return;
    pending.current = true;
    setBusy(true);
    setIssue(null);
    try {
      const result = await loadProjects({ limit: 50, offset: start });
      if (!active.current) return;
      if (!result.ok) {
        setIssue(safeIssue(result.error.code));
        return;
      }
      setRows(result.data);
      setOffset(start);
      setLoaded(true);
      setMore(result.data.length === 50 && start < 100_000);
    } catch {
      if (active.current) setIssue("UNAVAILABLE");
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <div className="grid gap-[6px]">
      <Label htmlFor={id}>Target project (required)</Label>
      <select
        id={id}
        className={selectClass}
        value={value}
        disabled={disabled}
        onChange={(e) => change(e.target.value)}
      >
        <option value="">Select a project explicitly</option>
        {value && !rows.some((p) => p.id === value) ? (
          <option value={value}>Previously selected project (local)</option>
        ) : null}
        {rows.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <div className="flex flex-wrap gap-[8px]">
        <Button
          type="button"
          variant="secondary"
          disabled={disabled || busy || (loaded && !more && !issue)}
          onClick={() => load(issue ? offset : loaded ? offset + 50 : 0)}
        >
          {busy
            ? "Loading projects…"
            : issue
              ? "Retry project choices"
              : loaded
                ? "Next project choices"
                : "Load my projects"}
        </Button>
        {loaded ? (
          <Button
            type="button"
            variant="secondary"
            disabled={disabled || busy || offset === 0}
            onClick={() => load(Math.max(0, offset - 50))}
          >
            Previous project choices
          </Button>
        ) : null}
      </div>
      {loaded && !rows.length ? <p role="status">No owned projects on this page.</p> : null}
      {issue ? (
        <p role="alert" className="text-[13px] text-destructive">
          {issueMessages[issue]}
        </p>
      ) : null}
    </div>
  );
}
export function ManagementPreview({
  proposal,
  edit,
  saveState,
  change,
  save,
  recover,
  loadProjects,
  sources = [],
  blocked = false,
}: {
  proposal: ManagementProposalView;
  edit?: ManagementEdit;
  saveState?: ManagementSave;
  change: (edit: ManagementEdit) => void;
  save: () => void;
  recover: () => void;
  loadProjects: typeof listProposalProjects;
  sources?: SourceView[];
  blocked?: boolean;
}) {
  const locked = !!saveState && saveState.phase !== "error";
  let value = edit ?? originalManagementEdit(proposal);
  if (locked && saveState) {
    const payload = saveState.payload;
    if (payload.kind === "create_project")
      value = { kind: payload.kind, name: payload.name, description: payload.description ?? "" };
    else if (payload.kind === "create_tasks" && value.kind === "create_tasks")
      value = {
        ...value,
        projectId: payload.projectId,
        items: value.items.map((item) => {
          const submitted = payload.items.find((i) => i.itemId === item.itemId);
          return { ...item, selected: !!submitted, fields: submitted?.fields ?? item.fields };
        }),
      };
  }
  const prefix = `management-${proposal.id}`;
  if (proposal.status === "confirmed")
    return (
      <section
        className="mt-[16px] grid gap-[8px] rounded-[7px] border border-border p-[16px]"
        aria-label="Confirmed management proposal"
      >
        <p>
          {proposal.kind === "create_project"
            ? "Project creation confirmed."
            : "Selected task creation confirmed."}
        </p>
        {proposal.receipt?.kind === "create_project" ? (
          proposal.receipt.result.state === "available" ? (
            <Link
              prefetch={false}
              href={`/projects/${proposal.receipt.result.projectId}`}
              className="underline"
            >
              Open project
            </Link>
          ) : (
            <p>Project unavailable or awaiting authorization refresh.</p>
          )
        ) : null}
        {proposal.receipt?.kind === "create_tasks" ? (
          <ul className="grid gap-[6px]">
            {proposal.receipt.results.map((result) => (
              <li key={result.itemId}>
                {result.state === "available" ? (
                  <Link prefetch={false} href={`/tasks/${result.taskId}`} className="underline">
                    Open created task {result.itemId}
                  </Link>
                ) : (
                  <>Task {result.itemId} unavailable or awaiting authorization refresh.</>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-[12px] text-muted-foreground">
          Original draft fields are not the final approved values. Open available results to view
          their current contents.
        </p>
        <Button type="button" variant="secondary" className="justify-self-start" onClick={recover}>
          Refresh availability
        </Button>
      </section>
    );
  const current = value;
  const payload = managementPayload(proposal, current);
  const disabled = locked || blocked;
  const selectedCount =
    current.kind === "create_tasks" ? current.items.filter((i) => i.selected).length : 0;
  const projectErrors =
    current.kind === "create_project" && !payload
      ? { name: current.name.trim() ? undefined : "Enter a project name." }
      : {};
  return (
    <form
      className="proposal-preview mt-[16px] grid min-w-0 gap-[12px] rounded-[7px] border border-border bg-canvas p-[16px]"
      aria-label={
        current.kind === "create_project" ? "Project draft preview" : "Task draft preview"
      }
      data-unsaved={managementEditDirty(proposal, edit) || locked ? "true" : "false"}
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked && (payload || saveState?.phase === "retry")) save();
      }}
    >
      <div>
        <h3 className="text-[15px] font-medium">
          {current.kind === "create_project"
            ? "Project draft — not saved as a project"
            : "Task drafts — not saved as tasks"}
        </h3>
        <p className="mt-[4px] text-[12px] text-muted-foreground">
          Review and confirm explicitly. Edits stay local; reload restores the original unconfirmed
          draft.
        </p>
      </div>
      <fieldset disabled={disabled} className="grid min-w-0 gap-[12px]">
        {current.kind === "create_project" ? (
          <>
            <div className="grid gap-[6px]">
              <Label htmlFor={`${prefix}-name`}>Project name</Label>
              <Input
                id={`${prefix}-name`}
                className="form-control"
                maxLength={200}
                value={current.name}
                aria-invalid={!!projectErrors.name}
                aria-describedby={projectErrors.name ? `${prefix}-name-error` : undefined}
                onChange={(e) => change({ ...current, name: e.target.value })}
              />
              <FieldError id={`${prefix}-name-error`} message={projectErrors.name} />
            </div>
            <div className="grid gap-[6px]">
              <Label htmlFor={`${prefix}-description`}>Description (optional)</Label>
              <Textarea
                id={`${prefix}-description`}
                className="form-control h-[160px] max-h-[40dvh] field-sizing-fixed resize-none overflow-y-auto"
                maxLength={5000}
                value={current.description}
                onChange={(e) => change({ ...current, description: e.target.value })}
              />
            </div>
            <p className="text-[12px] text-muted-foreground">
              Initial tasks require a separate draft and confirmation after this project is created.
            </p>
          </>
        ) : (
          <>
            {proposal.scopedProject ? (
              <p>Project: {proposal.scopedProject.name} (fixed)</p>
            ) : (
              <ProjectChoices
                id={`${prefix}-project`}
                value={current.projectId}
                change={(projectId) => change({ ...current, projectId })}
                disabled={disabled}
                loadProjects={loadProjects}
              />
            )}
            <p className="text-[12px] text-muted-foreground">
              Select a compatible subset for one project. Retrieved excerpts are not full notes and
              may omit other tasks.
            </p>
            {current.items.map((item, index) => {
              const original =
                proposal.draft.kind === "create_tasks" ? proposal.draft.items[index] : undefined;
              const evidence = original?.evidence;
              const source = evidence?.type === "retrieved_note" ? evidence.source : null;
              const metadata =
                source?.state === "available"
                  ? sources.find((s) => s.state === "available" && s.noteId === source.noteId)
                  : null;
              const validate = managementTaskFields.safeParse(item.fields);
              const errors = item.selected && !validate.success ? fieldErrors(validate.error) : {};
              const update = (patch: Partial<typeof item>) =>
                change({
                  ...current,
                  items: current.items.map((i) =>
                    i.itemId === item.itemId ? { ...i, ...patch } : i,
                  ),
                });
              const setFields = (patch: Partial<typeof item.fields>) =>
                update({ fields: { ...item.fields, ...patch } });
              const itemPrefix = `${prefix}-${item.itemId}`;
              return (
                <div
                  key={item.itemId}
                  className="grid min-w-0 gap-[10px] border-t border-border pt-[12px]"
                >
                  <label className="flex items-center gap-[8px]">
                    <input
                      type="checkbox"
                      checked={item.selected}
                      onChange={(e) => update({ selected: e.target.checked })}
                    />
                    Create task {item.itemId}
                  </label>
                  <fieldset disabled={!item.selected} className="grid min-w-0 gap-[10px]">
                    <div className="grid gap-[6px]">
                      <Label htmlFor={`${itemPrefix}-title`}>Title</Label>
                      <Input
                        id={`${itemPrefix}-title`}
                        className="form-control"
                        value={item.fields.title}
                        maxLength={300}
                        aria-invalid={!!errors.title}
                        aria-describedby={errors.title ? `${itemPrefix}-title-error` : undefined}
                        onChange={(e) => setFields({ title: e.target.value })}
                      />
                      <FieldError id={`${itemPrefix}-title-error`} message={errors.title} />
                    </div>
                    <div className="grid gap-[6px]">
                      <Label htmlFor={`${itemPrefix}-description`}>Description (optional)</Label>
                      <Textarea
                        id={`${itemPrefix}-description`}
                        className="form-control h-[120px] max-h-[35dvh] field-sizing-fixed resize-none overflow-y-auto"
                        value={item.fields.description ?? ""}
                        maxLength={5000}
                        onChange={(e) => setFields({ description: e.target.value || null })}
                      />
                    </div>
                    <div className="grid gap-[10px] sm:grid-cols-2">
                      <div className="grid gap-[6px]">
                        <Label htmlFor={`${itemPrefix}-status`}>Status</Label>
                        <select
                          id={`${itemPrefix}-status`}
                          className={selectClass}
                          value={item.fields.status}
                          onChange={(e) =>
                            setFields({ status: e.target.value as typeof item.fields.status })
                          }
                        >
                          {["todo", "in_progress", "blocked", "done"].map((s) => (
                            <option key={s} value={s}>
                              {s.replaceAll("_", " ")}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="grid gap-[6px]">
                        <Label htmlFor={`${itemPrefix}-priority`}>Priority (optional)</Label>
                        <select
                          id={`${itemPrefix}-priority`}
                          className={selectClass}
                          value={item.fields.priority ?? ""}
                          onChange={(e) =>
                            setFields({
                              priority: (e.target.value || null) as typeof item.fields.priority,
                            })
                          }
                        >
                          <option value="">No priority</option>
                          {["urgent", "high", "medium", "low"].map((s) => (
                            <option key={s} value={s}>
                              {s}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="grid gap-[6px]">
                        <Label htmlFor={`${itemPrefix}-assignee`}>PIC (optional)</Label>
                        <Input
                          id={`${itemPrefix}-assignee`}
                          className="form-control"
                          value={item.fields.assignee ?? ""}
                          maxLength={200}
                          onChange={(e) => setFields({ assignee: e.target.value || null })}
                        />
                      </div>
                      <div className="grid gap-[6px]">
                        <Label htmlFor={`${itemPrefix}-date`}>Due date (optional)</Label>
                        <Input
                          id={`${itemPrefix}-date`}
                          className="form-control"
                          type="date"
                          min="0001-01-01"
                          max="9999-12-31"
                          value={item.fields.dueDate ?? ""}
                          aria-invalid={!!errors.dueDate || item.invalidDate}
                          aria-describedby={
                            errors.dueDate || item.invalidDate
                              ? `${itemPrefix}-date-error`
                              : undefined
                          }
                          onChange={(e) =>
                            update({
                              fields: { ...item.fields, dueDate: e.target.value || null },
                              invalidDate:
                                e.target.validity.badInput ||
                                e.target.validity.rangeOverflow ||
                                e.target.validity.rangeUnderflow ||
                                undefined,
                            })
                          }
                        />
                        <FieldError
                          id={`${itemPrefix}-date-error`}
                          message={
                            item.invalidDate ? "Enter a valid calendar date." : errors.dueDate
                          }
                        />
                      </div>
                    </div>
                    {source ? (
                      <div className="grid gap-[6px] text-[12px]">
                        <p>Based on a bounded retrieved excerpt, not a full-note review.</p>
                        {source.state === "available" ? (
                          <>
                            <Link
                              prefetch={false}
                              href={`/projects/${source.projectId}/notes/${source.noteId}`}
                              className="underline"
                            >
                              {metadata?.state === "available"
                                ? `${metadata.projectName} · ${metadata.title}`
                                : "Open source note"}
                            </Link>
                            {source.updatedAt !== source.retrievedUpdatedAt ? (
                              <p role="alert">
                                Source changed. Request a new extraction before creating this task.
                              </p>
                            ) : null}
                            {current.projectId && source.projectId !== current.projectId ? (
                              <p role="alert">
                                This source belongs to another project. Choose its project or
                                deselect this task.
                              </p>
                            ) : null}
                            <label className="flex items-center gap-[8px]">
                              <input
                                type="checkbox"
                                checked={item.fields.sourceNoteId !== null}
                                onChange={(e) =>
                                  setFields({
                                    sourceNoteId: e.target.checked ? source.noteId : null,
                                  })
                                }
                              />
                              Keep source-note link
                            </label>
                          </>
                        ) : (
                          <p role="alert">
                            Source unavailable or awaiting authorization refresh. Reload saved
                            history; clearing its link does not bypass source checks.
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-[12px] text-muted-foreground">
                        Based on explicitly supplied user content.
                      </p>
                    )}
                  </fieldset>
                </div>
              );
            })}
          </>
        )}
      </fieldset>
      {!payload && !locked ? (
        <p className="text-[13px] text-muted-foreground">
          {current.kind === "create_tasks"
            ? "Choose a project and at least one valid task with compatible, unchanged sources."
            : "Check the project fields before creating it."}
        </p>
      ) : null}
      {blocked ? <p role="status">Check saved history before confirming this draft.</p> : null}
      {saveState ? (
        <div role="status" className="text-[13px]">
          {saveState.phase === "saving"
            ? "Creating…"
            : saveState.phase === "checking"
              ? "Checking saved result…"
              : saveState.phase === "retry"
                ? "Creation is not confirmed. Only the same approval can be retried."
                : saveState.phase === "error"
                  ? "Creation was rejected. Your edits are retained."
                  : "Creation unconfirmed. Check saved status before retrying."}
          {saveState.issue ? (
            <p>
              {saveState.issue === "CONFLICT"
                ? "The approval or its source changed. Check saved status; a changed source needs a new extraction."
                : saveState.issue === "NOT_FOUND"
                  ? "The proposal, project or source is unavailable."
                  : saveState.issue === "INVALID_INPUT"
                    ? "Check the preview fields."
                    : issueMessages[saveState.issue]}
            </p>
          ) : null}
          {saveState.issue === "UNAUTHENTICATED" ? (
            <Link href="/login" target="_blank" rel="noopener noreferrer" className="underline">
              Sign in in a new tab
            </Link>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-[8px]">
        <Button
          type="submit"
          disabled={
            blocked ||
            (!payload && saveState?.phase !== "retry") ||
            (locked && saveState?.phase !== "retry")
          }
        >
          {saveState?.phase === "retry"
            ? "Retry same approval"
            : current.kind === "create_project"
              ? "Create project"
              : `Create ${selectedCount} ${selectedCount === 1 ? "task" : "tasks"}`}
        </Button>
        {saveState ? (
          <Button
            type="button"
            variant="secondary"
            disabled={saveState.phase === "saving" || saveState.phase === "checking"}
            onClick={recover}
          >
            Check creation status
          </Button>
        ) : null}
      </div>
    </form>
  );
}
