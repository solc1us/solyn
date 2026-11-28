"use client";

import { Button } from "@solyn/ui/components/button";
import { Input } from "@solyn/ui/components/input";
import { Label } from "@solyn/ui/components/label";
import { Textarea } from "@solyn/ui/components/textarea";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { createTask, deleteTask, getTask, updateTask } from "./actions";
import { FieldError } from "./feedback";
import { formatDate } from "./presentation";
import { ProjectSelect, SourceNoteSelect, type ProjectChoice } from "./task-pickers";
import {
  createTaskEditor,
  priorities,
  statuses,
  taskDirty,
  taskErrorMessage,
  taskSelectClass,
  type Task,
  type TaskDraft,
} from "./task-state";
import { useUnsavedChanges } from "./use-unsaved-changes";

export default function TaskEditor({
  initial,
  project,
  projects = [],
  initialSource,
}: {
  initial?: Task;
  project?: ProjectChoice;
  projects?: ProjectChoice[];
  initialSource?: { id: string; title: string };
}) {
  const router = useRouter();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const [editor] = useState(() =>
    createTaskEditor(initial, project?.id ?? "", {
      create: createTask,
      update: updateTask,
      remove: deleteTask,
      read: getTask,
    }),
  );
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  const [navigating, startTransition] = useTransition();
  const pending = state.pending !== false || navigating || state.deleted;
  const dirty = taskDirty(state.draft, state.saved, project?.id);
  const blocked = state.error === "CONFLICT" || state.error === "UNAVAILABLE";
  useUnsavedChanges(!state.deleted && (dirty || pending));
  const errorProps = (field: string) => ({
    "aria-invalid": !!state.errors[field],
    "aria-describedby": state.errors[field] ? `task-${field}-error` : undefined,
  });
  const change = (field: keyof TaskDraft, value: string) => editor.change(field, value);
  return (
    <form
      className="task-editor m-0 min-w-0 w-full"
      noValidate
      data-unsaved={!state.deleted && (dirty || pending)}
      aria-busy={pending}
      onSubmit={async (event) => {
        event.preventDefault();
        if (pending) return;
        const form = event.currentTarget;
        const wasNew = !state.saved;
        const saved = await editor.save(
          form.querySelector<HTMLInputElement>("#task-dueDate")?.validity.valid === false,
        );
        if (!active.current) return; // A late acknowledgement must not redirect a departed editor.
        if (!saved) {
          requestAnimationFrame(() =>
            form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
          );
          return;
        }
        startTransition(() => {
          if (wasNew) router.replace(`/tasks/${saved.id}`);
          router.refresh();
        });
      }}
    >
      <header className="page-heading -mx-[24px] mb-[20px] flex items-center justify-between gap-[16px] border-b border-solid border-border px-[24px] pb-[16px] [@media(min-width:761px)]:sticky [@media(min-width:761px)]:top-0 [@media(min-width:761px)]:z-10 [@media(min-width:761px)]:-mt-[20px] [@media(min-width:761px)]:bg-canvas [@media(min-width:761px)]:pt-[20px] [@media(max-width:1100px)]:flex-wrap [@media(max-width:760px)]:mx-0 [@media(max-width:760px)]:mb-[16px] [@media(max-width:760px)]:gap-[12px] [@media(max-width:760px)]:px-0">
        <h1 className="min-w-0 text-[16px] font-[600] tracking-[-0.015em] text-foreground">
          {state.saved ? "Edit Task" : "Create Task"}
        </h1>
        <div className="ml-auto flex items-center gap-[12px] [@media(max-width:760px)]:gap-[10px]">
          <p role="status" className="text-[13px] text-muted-foreground">
            {state.pending === "read"
              ? "Loading…"
              : state.pending === "delete"
                ? "Deleting…"
                : pending
                  ? "Saving…"
                  : dirty
                    ? "Unsaved changes"
                    : state.savedFeedback
                      ? "Saved"
                      : ""}
          </p>
          <Button type="submit" disabled={pending || blocked || (!!state.saved && !dirty)}>
            {state.pending === "save" ? "Saving…" : state.saved ? "Save changes" : "Create task"}
          </Button>
        </div>
      </header>
      <FieldError id="task-form-error" message={state.errors.form} />
      <fieldset disabled={pending} className="grid min-w-0 gap-[20px]">
        <div className="grid gap-[9px]">
          <Label htmlFor="task-title">Title (required)</Label>
          <Input
            id="task-title"
            name="title"
            className="form-control text-[18px] font-[550]"
            value={state.draft.title}
            onChange={(event) => change("title", event.target.value)}
            maxLength={300}
            required
            autoComplete="off"
            {...errorProps("title")}
          />
          <FieldError id="task-title-error" message={state.errors.title} />
        </div>
        {state.saved || project ? (
          <div className="grid gap-[9px]">
            <Label htmlFor="task-project">Project</Label>
            <Input
              id="task-project"
              className="form-control"
              value={project?.name ?? "Selected project"}
              disabled
              readOnly
            />
          </div>
        ) : (
          <ProjectSelect
            initial={projects}
            value={state.draft.projectId}
            onChange={(value) => change("projectId", value)}
            disabled={pending}
            invalid={!!state.errors.projectId}
          />
        )}
        <FieldError id="task-projectId-error" message={state.errors.projectId} />
        <div className="grid gap-[9px]">
          <Label htmlFor="task-description">Description</Label>
          <Textarea
            id="task-description"
            name="description"
            className="form-control h-[160px] max-h-[40dvh] field-sizing-fixed resize-none overflow-y-auto"
            value={state.draft.description}
            onChange={(event) => change("description", event.target.value)}
            maxLength={5000}
            {...errorProps("description")}
          />
          <FieldError id="task-description-error" message={state.errors.description} />
        </div>
        <div className="grid grid-cols-2 gap-[20px] [@media(max-width:760px)]:grid-cols-1">
          <div className="grid gap-[9px]">
            <Label htmlFor="task-status">Status</Label>
            <select
              id="task-status"
              name="status"
              className={taskSelectClass}
              value={state.draft.status}
              onChange={(event) => change("status", event.target.value)}
              {...errorProps("status")}
            >
              {Object.entries(statuses).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <FieldError id="task-status-error" message={state.errors.status} />
          </div>
          <div className="grid gap-[9px]">
            <Label htmlFor="task-priority">Priority</Label>
            <select
              id="task-priority"
              name="priority"
              className={taskSelectClass}
              value={state.draft.priority}
              onChange={(event) => change("priority", event.target.value)}
              {...errorProps("priority")}
            >
              <option value="">No priority</option>
              {Object.entries(priorities).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <FieldError id="task-priority-error" message={state.errors.priority} />
          </div>
          <div className="grid gap-[9px]">
            <Label htmlFor="task-dueDate">Due date</Label>
            <Input
              id="task-dueDate"
              name="dueDate"
              type="date"
              className="form-control"
              min="0001-01-01"
              max="9999-12-31"
              value={state.draft.dueDate}
              onChange={(event) => change("dueDate", event.target.value)}
              {...errorProps("dueDate")}
            />
            <FieldError id="task-dueDate-error" message={state.errors.dueDate} />
          </div>
          <div className="grid gap-[9px]">
            <Label htmlFor="task-assignee">PIC</Label>
            <Input
              id="task-assignee"
              name="assignee"
              className="form-control"
              value={state.draft.assignee}
              maxLength={200}
              onChange={(event) => change("assignee", event.target.value)}
              {...errorProps("assignee")}
            />
            <FieldError id="task-assignee-error" message={state.errors.assignee} />
          </div>
        </div>
        <SourceNoteSelect
          key={state.draft.projectId}
          projectId={state.draft.projectId}
          value={state.draft.sourceNoteId}
          onChange={(value) => change("sourceNoteId", value)}
          initialSource={initialSource}
          disabled={pending}
          invalid={!!state.errors.sourceNoteId}
        />
        <FieldError id="task-sourceNoteId-error" message={state.errors.sourceNoteId} />
      </fieldset>
      {state.error ? (
        <div role="alert" className="mt-[20px] grid gap-[12px] text-[14px] text-destructive">
          <p>{taskErrorMessage(state.error)}</p>
          {state.error === "UNAUTHENTICATED" ? (
            <Link href="/login" target="_blank" rel="noopener noreferrer" className="underline">
              Sign in in a new tab
            </Link>
          ) : null}
          {state.saved ? (
            <Button
              type="button"
              variant="secondary"
              className="justify-self-start"
              disabled={pending}
              onClick={() => editor.loadLatest()}
            >
              Check latest saved version
            </Button>
          ) : (
            <>
              <Link href="/tasks" target="_blank" rel="noopener noreferrer" className="underline">
                Check persisted tasks in a new tab before retrying
              </Link>
              {state.error === "UNAVAILABLE" ? (
                <Button
                  type="button"
                  variant="secondary"
                  className="justify-self-start"
                  onClick={() => editor.allowCreateRetry((message) => window.confirm(message))}
                >
                  I checked tasks — allow retry
                </Button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {state.reloadError ? (
        <p role="alert" className="mt-[16px] text-destructive">
          {taskErrorMessage(state.reloadError)}
        </p>
      ) : null}
      {state.latest ? (
        <section
          aria-label="Latest saved task"
          className="mt-[24px] grid gap-[12px] border-t border-border pt-[20px]"
        >
          <h2 className="text-[14px] font-medium">Latest saved version {state.latest.version}</h2>
          <p className="text-[13px] text-muted-foreground">
            Your draft above is unchanged. Copy anything you want to keep before replacing it.
          </p>
          <h3 className="[overflow-wrap:anywhere]">{state.latest.title}</h3>
          <Textarea
            className="form-control h-[160px] field-sizing-fixed resize-none overflow-y-auto"
            readOnly
            aria-label="Latest saved task description"
            value={state.latest.description ?? ""}
          />
          <dl className="grid gap-[8px] text-[13px] [overflow-wrap:anywhere]">
            {Object.entries({
              Status: statuses[state.latest.status as keyof typeof statuses],
              Priority: state.latest.priority ?? "No priority",
              PIC: state.latest.assignee ?? "Not set",
              "Due date": state.latest.dueDate ? formatDate(state.latest.dueDate) : "Not set",
              "Source note": state.latest.sourceNoteId ?? "None",
            }).map(([label, value]) => (
              <div key={label}>
                <dt className="inline text-muted-foreground">{label}: </dt>
                <dd className="inline">{value}</dd>
              </div>
            ))}
          </dl>
          <Button
            type="button"
            variant="secondary"
            className="justify-self-start"
            disabled={pending}
            onClick={() => {
              if (
                dirty &&
                !window.confirm(
                  "Replace your unsaved task draft with the latest saved version? Copy anything you want to keep first.",
                )
              )
                return;
              editor.useLatest();
            }}
          >
            Use latest saved version
          </Button>
        </section>
      ) : null}
      {state.saved ? (
        <footer className="mt-[28px] flex flex-wrap items-center gap-[16px] border-t border-border pt-[18px] text-[12px] text-muted-foreground">
          <span>Version {state.saved.version}</span>
          <span>Last saved {formatDate(state.saved.updatedAt)}</span>
          <Link className="underline" href={`/projects/${state.saved.projectId}?view=tasks`}>
            Project tasks
          </Link>
          <Button
            type="button"
            variant="destructive"
            className="ml-auto"
            disabled={pending || blocked}
            onClick={async () => {
              if ((await editor.remove((message) => window.confirm(message))) && active.current)
                startTransition(() => {
                  router.replace(`/projects/${state.saved!.projectId}?view=tasks`);
                  router.refresh();
                });
            }}
          >
            Delete task
          </Button>
        </footer>
      ) : null}
    </form>
  );
}
