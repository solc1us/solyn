import { z } from "zod";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAVAILABLE";
export type WorkspaceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string } };

export const uuid = z.uuid().transform((value) => value.toLowerCase());
const name = z.string().trim().min(1).max(200);
const title = z.string().trim().min(1).max(300);
// Do not trim or otherwise transform original note content.
const content = z
  .string()
  .min(1)
  .max(100_000)
  .refine((value) => value.trim().length > 0);
const description = z.string().max(5_000).nullable();
const noteDate = z.iso
  .date()
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value &&
      !value.startsWith("0000")
    );
  }, "Use a valid calendar date in YYYY-MM-DD format")
  .nullable();
const pagination = {
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
};
export const listProjectsInput = z.strictObject(pagination);
export const projectInput = z.strictObject({ projectId: uuid });
export const createProjectInput = z.strictObject({ name, description: description.optional() });
export const updateProjectInput = z
  .strictObject({ projectId: uuid, name: name.optional(), description: description.optional() })
  .refine(
    (value) => value.name !== undefined || value.description !== undefined,
    "Provide a project change",
  );
export const listNotesInput = z.strictObject({ projectId: uuid, ...pagination });
export const searchNotesInput = z.strictObject({
  projectId: uuid,
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    // PostgreSQL text cannot represent NUL or unpaired Unicode surrogates.
    .refine((value) => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value)),
  limit: pagination.limit.unwrap().max(50).default(20),
  offset: pagination.offset,
});
export type SearchNotesInput = z.input<typeof searchNotesInput>;
// Separate owner-wide read contract; omission means all projects of the session owner.
export const searchOwnedNotesInput = searchNotesInput.partial({ projectId: true });
export type SearchOwnedNotesInput = z.input<typeof searchOwnedNotesInput>;
export const noteInput = z.strictObject({ projectId: uuid, noteId: uuid });
export const createNoteInput = z.strictObject({
  projectId: uuid,
  title,
  content,
  noteDate: noteDate.optional(),
});
export const updateNoteInput = z
  .strictObject({
    projectId: uuid,
    noteId: uuid,
    expectedVersion: z.number().int().min(1).max(2_147_483_647),
    title: title.optional(),
    content: content.optional(),
    noteDate: noteDate.optional(),
  })
  .refine(
    (value) =>
      value.title !== undefined || value.content !== undefined || value.noteDate !== undefined,
    "Provide a note change",
  );

// Task text follows the existing PostgreSQL-compatible search/confirmation boundary.
const taskText = (value: string) => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value);
export const taskStatus = z.enum(["todo", "in_progress", "blocked", "done"]);
export const taskPriority = z.enum(["urgent", "high", "medium", "low"]).nullable();
const taskChanges = {
  title: title.refine(taskText),
  description: z.string().max(5_000).refine(taskText).nullable(),
  status: taskStatus,
  priority: taskPriority,
  assignee: z.string().max(200).refine(taskText).nullable(),
  dueDate: noteDate,
  sourceNoteId: uuid.nullable(),
};
const expectedTaskVersion = z.number().int().min(1).max(2_147_483_647);
export const createTaskInput = z.strictObject({
  projectId: uuid,
  ...taskChanges,
  description: taskChanges.description.optional(),
  status: taskStatus.default("todo"),
  priority: taskPriority.optional(),
  assignee: taskChanges.assignee.optional(),
  dueDate: noteDate.optional(),
  sourceNoteId: taskChanges.sourceNoteId.optional(),
});
export const taskInput = z.strictObject({ taskId: uuid });
export const updateTaskInput = z
  .strictObject({
    taskId: uuid,
    expectedVersion: expectedTaskVersion,
    ...z.object(taskChanges).partial().shape,
  })
  .refine(
    (value) =>
      Object.keys(taskChanges).some((key) => value[key as keyof typeof taskChanges] !== undefined),
    "Provide a task change",
  );
export const deleteTaskInput = z.strictObject({
  taskId: uuid,
  expectedVersion: expectedTaskVersion,
});
// Summary links need the same incomplete and date-only cutoff semantics as the overview.
const taskFilters = {
  status: z.union([taskStatus, z.literal("pending")]).optional(),
  overdueBefore: noteDate.unwrap().optional(),
  priority: taskPriority.optional(),
  dueDateFrom: noteDate.unwrap().optional(),
  dueDateTo: noteDate.unwrap().optional(),
  ...pagination,
};
const validTaskRange = (value: { dueDateFrom?: string; dueDateTo?: string }) =>
  !value.dueDateFrom || !value.dueDateTo || value.dueDateFrom <= value.dueDateTo;
export const listTasksInput = z
  .strictObject({ projectId: uuid, ...taskFilters })
  .refine(validTaskRange, "Invalid due-date range");
export const listOwnedTasksInput = z
  .strictObject({ projectId: uuid.optional(), ...taskFilters })
  .refine(validTaskRange, "Invalid due-date range");
// Internal read-only AI lookup: every filter is applied by SQL before the bound.
export const searchTasksInput = z
  .strictObject({
    projectId: uuid.optional(),
    title: searchNotesInput.shape.query.optional(),
    projectName: searchNotesInput.shape.query.optional(),
    status: z.enum(["todo", "in_progress", "blocked", "done", "pending"]).optional(),
    priority: taskPriority.optional(),
    dueDateFrom: noteDate.unwrap().optional(),
    dueDateTo: noteDate.unwrap().optional(),
    overdueBefore: noteDate.unwrap().optional(),
  })
  .refine(validTaskRange, "Invalid due-date range");
export const taskSummaryInput = z.strictObject({ today: noteDate.unwrap() });
export const taskSummaryCounts = z.strictObject({
  overdue: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dueSoon: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  inProgress: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export const taskSummaryRows = z
  .array(
    z.strictObject({
      id: uuid,
      projectId: uuid,
      projectName: name.refine(taskText),
      title: taskChanges.title,
      status: taskStatus,
      priority: taskPriority,
      dueDate: noteDate,
    }),
  )
  .max(5);
export type TaskOverview = {
  today: string;
  through: string;
  counts: z.output<typeof taskSummaryCounts> | null;
  attention: z.output<typeof taskSummaryRows> | null;
  inProgress: z.output<typeof taskSummaryRows> | null;
};
export type CreateTaskInput = z.input<typeof createTaskInput>;
export type UpdateTaskInput = z.input<typeof updateTaskInput>;
export type DeleteTaskInput = z.input<typeof deleteTaskInput>;
export type ListTasksInput = z.input<typeof listTasksInput>;
export type ListOwnedTasksInput = z.input<typeof listOwnedTasksInput>;

export type CreateProjectInput = z.input<typeof createProjectInput>;
export type UpdateProjectInput = z.input<typeof updateProjectInput>;
export type CreateNoteInput = z.input<typeof createNoteInput>;
export type UpdateNoteInput = z.input<typeof updateNoteInput>;
