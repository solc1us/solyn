import type { Route } from "next";
import type { createTask, deleteTask, getTask, listOwnedTasks, updateTask } from "./actions";
import { createTaskInput, listOwnedTasksInput, updateTaskInput, type ErrorCode } from "./contracts";
import type { FieldErrors } from "./presentation";

export type Task = Extract<Awaited<ReturnType<typeof getTask>>, { ok: true }>["data"];
export type TaskSummary = Extract<
  Awaited<ReturnType<typeof listOwnedTasks>>,
  { ok: true }
>["data"][number];
export const statuses = {
  todo: "Todo",
  in_progress: "In Progress",
  blocked: "Blocked",
  done: "Done",
} as const;
export const priorities = { urgent: "Urgent", high: "High", medium: "Medium", low: "Low" } as const;
export const taskSelectClass =
  "form-control min-h-[36px] min-w-0 w-full rounded-[7px] border border-input px-[10px] py-[7px] text-[16px] focus:border-ring aria-invalid:border-destructive [@media(max-width:760px)]:min-h-[44px]";
export type TaskDraft = {
  projectId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee: string;
  dueDate: string;
  sourceNoteId: string;
};
export function taskDraft(task?: Task, projectId = ""): TaskDraft {
  return {
    projectId: task?.projectId ?? projectId,
    title: task?.title ?? "",
    description: task?.description ?? "",
    status: task?.status ?? "todo",
    priority: task?.priority ?? "",
    assignee: task?.assignee ?? "",
    dueDate: task?.dueDate ?? "",
    sourceNoteId: task?.sourceNoteId ?? "",
  };
}
export function taskPayload(draft: TaskDraft, saved?: Task) {
  const fields = {
    ...draft,
    description: draft.description || null,
    priority: draft.priority || null,
    assignee: draft.assignee || null,
    dueDate: draft.dueDate || null,
    sourceNoteId: draft.sourceNoteId || null,
  };
  if (!saved) return createTaskInput.safeParse(fields);
  const baseline = taskDraft(saved);
  const changes = Object.fromEntries(
    Object.entries(fields).filter(
      ([key]) =>
        key !== "projectId" && draft[key as keyof TaskDraft] !== baseline[key as keyof TaskDraft],
    ),
  );
  return updateTaskInput.safeParse({
    taskId: saved.id,
    expectedVersion: saved.version,
    ...changes,
    ...(draft.projectId !== saved.projectId ? { projectId: draft.projectId } : {}),
  });
}
export function taskDirty(draft: TaskDraft, saved?: Task, projectId = "") {
  const baseline = taskDraft(saved, projectId);
  return Object.keys(draft).some(
    (key) => draft[key as keyof TaskDraft] !== baseline[key as keyof TaskDraft],
  );
}
export function taskErrors(
  issues: { path: PropertyKey[]; code: string; maximum?: number | bigint }[],
): FieldErrors {
  const errors: FieldErrors = {};
  const labels: Record<string, string> = {
    title: "task title",
    description: "description",
    assignee: "PIC name",
    projectId: "project",
    sourceNoteId: "source note",
    priority: "priority",
    status: "status",
    dueDate: "due date",
  };
  for (const issue of issues) {
    const key = String(issue.path[0] ?? "form");
    errors[key] ??=
      issue.code === "too_big" && issue.maximum != null
        ? `Maximum ${issue.maximum.toLocaleString("en-US")} characters.`
        : labels[key]
          ? `Please enter a valid ${labels[key]}.`
          : "Please review the task fields.";
  }
  return errors;
}
export function taskErrorMessage(code: ErrorCode) {
  if (code === "CONFLICT")
    return "This task changed elsewhere. Review the latest saved version before trying again. Your draft is unchanged.";
  if (code === "UNAVAILABLE")
    return "The outcome could not be confirmed. Check persisted tasks or the latest saved version before retrying.";
  if (code === "UNAUTHENTICATED")
    return "Your session has ended. Sign in in another tab, then return here.";
  if (code === "NOT_FOUND")
    return "This task, project or source note is no longer available, or you do not have access to it.";
  return "Review the task fields and try again.";
}
export function localCalendarDate(date = new Date()) {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function isOverdue(task: Pick<Task, "status" | "dueDate">, today: string | null) {
  return !!today && !!task.dueDate && task.status !== "done" && task.dueDate < today;
}
export type TaskQuery = Record<string, string | string[] | undefined>;
export function taskFilters(query: TaskQuery, projectId?: string) {
  const input: Record<string, unknown> = {};
  for (const key of ["projectId", "status", "priority", "dueDateFrom", "dueDateTo", "offset"]) {
    const value = query[key];
    if (value !== undefined && value !== "")
      input[key] =
        key === "offset" && typeof value === "string" && /^\d+$/.test(value)
          ? Number(value)
          : value;
  }
  if (input.priority === "none") input.priority = null;
  if (projectId) input.projectId = projectId; // Fixed route scope, never query-selected.
  return listOwnedTasksInput.safeParse({ ...input, limit: 50 });
}
export function taskPageHref(
  base: string,
  filters: ReturnType<typeof listOwnedTasksInput.parse>,
  offset: number,
) {
  const url = new URL(base, "https://solyn.invalid");
  for (const key of ["projectId", "status", "priority", "dueDateFrom", "dueDateTo"] as const) {
    if (base.startsWith("/projects/") && key === "projectId") continue;
    const value = filters[key];
    if (value !== undefined) url.searchParams.set(key, value === null ? "none" : value);
  }
  if (offset > 0) url.searchParams.set("offset", String(offset));
  else url.searchParams.delete("offset");
  return `${url.pathname}${url.search}` as Route;
}
export function taskStatusChange(task: Pick<TaskSummary, "id" | "version" | "status">) {
  return {
    taskId: task.id,
    expectedVersion: task.version,
    status: task.status === "done" ? "todo" : "done",
  };
}
export function taskDeletePrompt(task: Pick<Task, "title">, dirty: boolean) {
  return `Permanently delete “${task.title}”?${dirty ? " Your unsaved changes will also be lost." : ""} The project, source note and history will be kept. This cannot be undone.`;
}

type TaskActions = {
  create: typeof createTask;
  update: typeof updateTask;
  remove: typeof deleteTask;
  read: typeof getTask;
};
export type TaskEditorState = {
  draft: TaskDraft;
  saved?: Task;
  latest: Task | null;
  error: ErrorCode | null;
  reloadError: ErrorCode | null;
  errors: FieldErrors;
  pending: false | "save" | "read" | "delete";
  savedFeedback: boolean;
  deleted: boolean;
};
// View-local state, following the existing note-search store pattern. No browser storage/cache.
export function createTaskEditor(
  initial: Task | undefined,
  projectId: string,
  actions: TaskActions,
) {
  let state: TaskEditorState = {
    draft: taskDraft(initial, projectId),
    saved: initial,
    latest: null,
    error: null,
    reloadError: null,
    errors: {},
    pending: false,
    savedFeedback: false,
    deleted: false,
  };
  const listeners = new Set<() => void>();
  function patch(change: Partial<TaskEditorState>) {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  }
  function blocked() {
    return state.pending !== false || state.deleted;
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    change(field: keyof TaskDraft, value: string) {
      if (blocked() || (field === "projectId" && (state.saved || projectId))) return;
      const draft = {
        ...state.draft,
        [field]: value,
        ...(field === "projectId" ? { sourceNoteId: "" } : {}),
      };
      const errors = { ...state.errors };
      if (errors[field]) {
        delete errors[field];
        const parsed = taskPayload(draft);
        const message = !parsed.success ? taskErrors(parsed.error.issues)[field] : undefined;
        if (message) errors[field] = message;
      }
      if (field === "projectId") delete errors.sourceNoteId;
      patch({ draft, errors, savedFeedback: false });
    },
    async save(invalidDate = false) {
      if (blocked() || state.error === "CONFLICT" || state.error === "UNAVAILABLE") return null;
      const parsed = taskPayload(state.draft, state.saved);
      if (!parsed.success || invalidDate) {
        patch({
          errors: {
            ...(!parsed.success ? taskErrors(parsed.error.issues) : {}),
            ...(invalidDate ? { dueDate: "Please enter a valid due date." } : {}),
          },
        });
        return null;
      }
      patch({ pending: "save", errors: {}, error: null, savedFeedback: false });
      try {
        const result = state.saved
          ? await actions.update(parsed.data)
          : await actions.create(parsed.data);
        if (!result.ok) {
          patch({ error: result.error.code });
          return null;
        }
        patch({
          saved: result.data,
          draft: taskDraft(result.data),
          savedFeedback: true,
          latest: null,
        });
        return result.data;
      } catch {
        patch({ error: "UNAVAILABLE" });
        return null;
      } finally {
        patch({ pending: false });
      }
    },
    allowCreateRetry(confirm: (message: string) => boolean) {
      if (blocked() || state.saved || state.error !== "UNAVAILABLE") return;
      if (
        confirm(
          "Have you checked persisted tasks and confirmed this task was not created? Retrying an uncertain create can produce a duplicate.",
        )
      )
        patch({ error: null });
    },
    async loadLatest() {
      if (blocked() || !state.saved) return;
      patch({ pending: "read", reloadError: null, latest: null });
      try {
        const result = await actions.read({ taskId: state.saved.id });
        if (result.ok) patch({ latest: result.data });
        else patch({ reloadError: result.error.code });
      } catch {
        patch({ reloadError: "UNAVAILABLE" });
      } finally {
        patch({ pending: false });
      }
    },
    useLatest() {
      if (blocked() || !state.latest) return;
      patch({
        saved: state.latest,
        draft: taskDraft(state.latest),
        latest: null,
        error: null,
        reloadError: null,
        errors: {},
        savedFeedback: false,
      });
    },
    async remove(confirm: (message: string) => boolean) {
      if (blocked() || !state.saved || state.error === "CONFLICT" || state.error === "UNAVAILABLE")
        return false;
      if (!confirm(taskDeletePrompt(state.saved, taskDirty(state.draft, state.saved, projectId))))
        return false;
      patch({ pending: "delete", error: null });
      try {
        const result = await actions.remove({
          taskId: state.saved.id,
          expectedVersion: state.saved.version,
        });
        if (!result.ok) {
          patch({ error: result.error.code });
          return false;
        }
        patch({ deleted: true, savedFeedback: false });
        return true;
      } catch {
        patch({ error: "UNAVAILABLE" });
        return false;
      } finally {
        patch({ pending: false });
      }
    },
  };
}
