import type { Database } from "@solyn/db";
import { noteRevisions, notes, projects, tasks } from "@solyn/db/schema/workspace";
import { chatConversations, chatMessages } from "@solyn/db/schema/chat";
import { noteProposals } from "@solyn/db/schema/note-proposals";
import { managementProposals } from "@solyn/db/schema/management-proposals";
import {
  confirmManagementProposalInput,
  approvedManagementPayload,
  managementEqual,
  managementReceiptSchema,
} from "../chat/management-contracts";
import {
  parseManagementProposal,
  readManagementProposals,
  managementReferencesMatch,
} from "../chat/management-proposals";
import {
  and,
  desc,
  eq,
  exists,
  gte,
  isNull,
  lt,
  lte,
  ne,
  max,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { confirmNoteProposalInput } from "../chat/contracts";
import type { z } from "zod";

import * as contracts from "./contracts";
import { calendarDateOffset } from "./presentation";
import type { ErrorCode, WorkspaceResult } from "./contracts";

class WorkspaceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
const missing = () => new WorkspaceError("NOT_FOUND", "Resource not found.");
const conflict = () =>
  new WorkspaceError("CONFLICT", "This note has changed. Reload it before saving.");
const projectFields = {
  id: projects.id,
  name: projects.name,
  description: projects.description,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
};
const noteFields = {
  id: notes.id,
  projectId: notes.projectId,
  title: notes.title,
  content: notes.content,
  noteDate: notes.noteDate,
  createdAt: notes.createdAt,
  updatedAt: notes.updatedAt,
};
const taskFields = {
  id: tasks.id,
  projectId: tasks.projectId,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  priority: tasks.priority,
  assignee: tasks.assignee,
  dueDate: tasks.dueDate,
  sourceNoteId: tasks.sourceNoteId,
  version: tasks.version,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  completedAt: tasks.completedAt,
};
const taskConflict = () =>
  new WorkspaceError("CONFLICT", "This task has changed. Reload it before retrying.");
// A single-statement read of current state and logical version shares one snapshot.
const currentVersion =
  sql<number>`coalesce((select max(${noteRevisions.version}) from ${noteRevisions} where ${noteRevisions.noteId} = ${notes.id}), 0) + 1`.as(
    "version",
  );

// Internal composition seam, not a Server Action: dependencies are supplied only
// by server.ts (or offline tests). Never construct this from client/model identity.
export function createWorkspaceService(dependencies: {
  db: Database;
  getSession: () => Promise<{ user: { id: string } } | null>;
}) {
  const { db, getSession } = dependencies;
  const ownedProject = (projectId: string, ownerId: string) =>
    and(eq(projects.id, projectId), eq(projects.ownerId, ownerId));
  const ownedNote = (projectId: string, ownerId: string, noteId?: string) =>
    and(
      eq(notes.projectId, projectId),
      noteId ? eq(notes.id, noteId) : undefined,
      exists(
        db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, notes.projectId), eq(projects.ownerId, ownerId))),
      ),
    );

  async function run<S extends z.ZodType, T>(
    schema: S,
    input: unknown,
    work: (input: z.output<S>, ownerId: string) => Promise<T>,
  ): Promise<WorkspaceResult<T>> {
    try {
      const session = await getSession();
      if (!session?.user.id) throw new WorkspaceError("UNAUTHENTICATED", "Sign in to continue.");
      const parsed = schema.safeParse(input);
      if (!parsed.success)
        throw new WorkspaceError("INVALID_INPUT", "Check the supplied fields and try again.");
      return { ok: true, data: await work(parsed.data, session.user.id) };
    } catch (error) {
      if (error instanceof WorkspaceError)
        return { ok: false, error: { code: error.code, message: error.message } };
      // Never expose driver errors, SQL, credentials, or note content to callers.
      return {
        ok: false,
        error: { code: "UNAVAILABLE", message: "Workspace is unavailable. Please try again." },
      };
    }
  }

  type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
  async function lockOwnedProject(tx: Transaction, projectId: string, ownerId: string) {
    const [project] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(ownedProject(projectId, ownerId))
      .for("share");
    if (!project) throw missing();
    return project;
  }
  // Private transaction-compatible core: caller has authenticated/validated, and
  // owns the transaction. Never opens a nested independent transaction.
  async function createNoteInTransaction(
    tx: Transaction,
    value: z.output<typeof contracts.createNoteInput>,
    ownerId: string,
  ) {
    const project = await lockOwnedProject(tx, value.projectId, ownerId);
    const [note] = await tx
      .insert(notes)
      .values({
        projectId: project.id,
        title: value.title,
        content: value.content,
        noteDate: value.noteDate ?? null,
      })
      .returning(noteFields);
    if (!note) throw new Error("Insert returned no note");
    return { ...note, version: 1 };
  }
  const ownedConversation = (ownerId: string) =>
    and(
      eq(chatConversations.ownerId, ownerId),
      or(
        isNull(chatConversations.projectId),
        exists(
          db
            .select({ id: projects.id })
            .from(projects)
            .where(
              and(eq(projects.id, chatConversations.projectId), eq(projects.ownerId, ownerId)),
            ),
        ),
      ),
    );

  const ownedTask = (taskId: string, ownerId: string) =>
    and(
      eq(tasks.id, taskId),
      exists(
        db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, tasks.projectId), eq(projects.ownerId, ownerId))),
      ),
    );
  async function lockTask(tx: Transaction, taskId: string, ownerId: string) {
    const [task] = await tx
      .select(taskFields)
      .from(tasks)
      .where(ownedTask(taskId, ownerId))
      .for("update", { of: tasks });
    if (!task) throw missing();
    return task;
  }
  async function validateTaskSource(
    tx: Transaction,
    projectId: string,
    ownerId: string,
    sourceNoteId: string | null,
  ) {
    if (sourceNoteId === null) return;
    // The single-column FK alone cannot guarantee same-project provenance.
    const [note] = await tx
      .select({ id: notes.id })
      .from(notes)
      .where(ownedNote(projectId, ownerId, sourceNoteId))
      .for("share", { of: notes });
    if (!note) throw missing();
  }
  async function createProjectInTransaction(
    tx: Pick<Transaction, "insert">,
    value: z.output<typeof contracts.createProjectInput>,
    ownerId: string,
  ) {
    const [project] = await tx
      .insert(projects)
      .values({ ownerId, name: value.name, description: value.description ?? null })
      .returning(projectFields);
    if (!project) throw new Error("Insert returned no project");
    return project;
  }
  async function createTaskInTransaction(
    tx: Transaction,
    value: z.output<typeof contracts.createTaskInput>,
    ownerId: string,
  ) {
    await lockOwnedProject(tx, value.projectId, ownerId);
    await validateTaskSource(tx, value.projectId, ownerId, value.sourceNoteId ?? null);
    const [task] = await tx
      .insert(tasks)
      .values({
        projectId: value.projectId,
        title: value.title,
        description: value.description ?? null,
        status: value.status,
        priority: value.priority ?? null,
        assignee: value.assignee ?? null,
        dueDate: value.dueDate ?? null,
        sourceNoteId: value.sourceNoteId ?? null,
        version: 1,
        completedAt: value.status === "done" ? sql`now()` : null,
      })
      .returning(taskFields);
    if (!task) throw new Error("Insert returned no task");
    return task;
  }
  async function updateTaskInTransaction(
    tx: Transaction,
    value: z.output<typeof contracts.updateTaskInput>,
    ownerId: string,
    locked?: Awaited<ReturnType<typeof lockTask>>,
  ) {
    const task = locked ?? (await lockTask(tx, value.taskId, ownerId));
    if (task.id !== value.taskId || task.version !== value.expectedVersion) throw taskConflict();
    const next = {
      title: value.title ?? task.title,
      description: value.description === undefined ? task.description : value.description,
      status: value.status ?? task.status,
      priority: value.priority === undefined ? task.priority : value.priority,
      assignee: value.assignee === undefined ? task.assignee : value.assignee,
      dueDate: value.dueDate === undefined ? task.dueDate : value.dueDate,
      sourceNoteId: value.sourceNoteId === undefined ? task.sourceNoteId : value.sourceNoteId,
    };
    if (Object.entries(next).every(([key, field]) => task[key as keyof typeof next] === field))
      return task;
    if (task.version >= 2_147_483_647) throw taskConflict();
    if (next.sourceNoteId !== task.sourceNoteId)
      await validateTaskSource(tx, task.projectId, ownerId, next.sourceNoteId);
    const now = new Date();
    const [updated] = await tx
      .update(tasks)
      .set({
        ...next,
        version: task.version + 1,
        updatedAt: now,
        completedAt: next.status === "done" ? (task.completedAt ?? now) : null,
      })
      .where(and(ownedTask(task.id, ownerId), eq(tasks.version, value.expectedVersion)))
      .returning(taskFields);
    if (!updated) throw taskConflict();
    return updated;
  }
  async function readTaskList(
    value: z.output<typeof contracts.listOwnedTasksInput>,
    ownerId: string,
  ) {
    // Summaries omit long descriptions and all account/auth metadata.
    const { description: _description, ...summary } = taskFields;
    return db
      .select({ ...summary, projectName: projects.name })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(
        and(
          eq(projects.ownerId, ownerId),
          value.projectId ? eq(tasks.projectId, value.projectId) : undefined,
          value.status === "pending"
            ? ne(tasks.status, "done")
            : value.status !== undefined
              ? eq(tasks.status, value.status)
              : undefined,
          value.overdueBefore
            ? and(lt(tasks.dueDate, value.overdueBefore), ne(tasks.status, "done"))
            : undefined,
          value.priority === undefined
            ? undefined
            : value.priority === null
              ? isNull(tasks.priority)
              : eq(tasks.priority, value.priority),
          value.dueDateFrom ? gte(tasks.dueDate, value.dueDateFrom) : undefined,
          value.dueDateTo ? lte(tasks.dueDate, value.dueDateTo) : undefined,
        ),
      )
      .orderBy(desc(tasks.updatedAt), desc(tasks.id))
      .limit(value.limit)
      .offset(value.offset);
  }

  return {
    getTaskSummary(input: unknown) {
      return run(
        contracts.taskSummaryInput,
        input,
        async ({ today }, ownerId): Promise<contracts.TaskOverview> => {
          const through = calendarDateOffset(today, 6);
          const overdue = and(ne(tasks.status, "done"), lt(tasks.dueDate, today));
          const dueSoon = and(
            ne(tasks.status, "done"),
            gte(tasks.dueDate, today),
            lte(tasks.dueDate, through),
          );
          const active = eq(tasks.status, "in_progress");
          const scope = eq(projects.ownerId, ownerId);
          const fields = {
            id: tasks.id,
            projectId: tasks.projectId,
            projectName: projects.name,
            title: tasks.title,
            status: tasks.status,
            priority: tasks.priority,
            dueDate: tasks.dueDate,
          };
          // Independent read statements allow honest partial failure. Counts scan the
          // entire owned set, never a preview page. Each statement has its own snapshot.
          const [counts, attention, inProgress] = await Promise.all([
            (async () => {
              const [row] = await db
                .select({
                  overdue: sql<number>`count(*) filter (where ${overdue})`.mapWith(Number),
                  dueSoon: sql<number>`count(*) filter (where ${dueSoon})`.mapWith(Number),
                  inProgress: sql<number>`count(*) filter (where ${active})`.mapWith(Number),
                })
                .from(tasks)
                .innerJoin(projects, eq(projects.id, tasks.projectId))
                .where(scope);
              return contracts.taskSummaryCounts.parse(row);
            })().catch(() => null),
            (async () =>
              contracts.taskSummaryRows.parse(
                await db
                  .select(fields)
                  .from(tasks)
                  .innerJoin(projects, eq(projects.id, tasks.projectId))
                  .where(and(scope, ne(tasks.status, "done"), lte(tasks.dueDate, through)))
                  .orderBy(tasks.dueDate, tasks.id)
                  .limit(5),
              ))().catch(() => null),
            (async () =>
              contracts.taskSummaryRows.parse(
                await db
                  .select(fields)
                  .from(tasks)
                  .innerJoin(projects, eq(projects.id, tasks.projectId))
                  .where(and(scope, active))
                  .orderBy(sql`${tasks.dueDate} asc nulls last`, tasks.id)
                  .limit(5),
              ))().catch(() => null),
          ]);
          return { today, through, counts, attention, inProgress };
        },
      );
    },
    createTask(input: unknown) {
      return run(contracts.createTaskInput, input, (value, ownerId) =>
        db.transaction((tx) => createTaskInTransaction(tx, value, ownerId), {
          isolationLevel: "read committed",
        }),
      );
    },
    getTask(input: unknown) {
      return run(contracts.taskInput, input, async (value, ownerId) => {
        const [task] = await db
          .select(taskFields)
          .from(tasks)
          .where(ownedTask(value.taskId, ownerId));
        if (!task) throw missing();
        return task;
      });
    },
    listTasks(input: unknown) {
      return run(contracts.listTasksInput, input, async (value, ownerId) => {
        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(ownedProject(value.projectId, ownerId));
        if (!project) throw missing();
        return readTaskList(value, ownerId);
      });
    },
    listOwnedTasks(input: unknown = {}) {
      // Optional foreign/missing project filters return the same empty collection.
      return run(contracts.listOwnedTasksInput, input, readTaskList);
    },
    searchTasks(input: unknown = {}) {
      return run(contracts.searchTasksInput, input, (value, ownerId) =>
        db.transaction(
          async (tx) => {
            // Names are filters, never identity/authorization. Detect ambiguous project
            // filters even when only one matching task happens to exist.
            const literal = (v: string) => `%${v.replace(/[!%_]/g, "!$&")}%`;
            const nameFilter = value.projectName
              ? sql`${projects.name} ilike ${literal(value.projectName)} escape '!'`
              : undefined;
            const candidates = nameFilter
              ? await tx
                  .select({ id: projects.id })
                  .from(projects)
                  .where(
                    and(
                      eq(projects.ownerId, ownerId),
                      nameFilter,
                      value.projectId ? eq(projects.id, value.projectId) : undefined,
                    ),
                  )
                  .limit(2)
              : [];
            const rows = await tx
              .select({
                id: tasks.id,
                projectId: tasks.projectId,
                projectName: projects.name,
                title: tasks.title,
                description: sql<string | null>`left(${tasks.description}, 160)`,
                status: tasks.status,
                priority: tasks.priority,
                assignee: tasks.assignee,
                dueDate: tasks.dueDate,
                version: tasks.version,
              })
              .from(tasks)
              .innerJoin(projects, eq(projects.id, tasks.projectId))
              .where(
                and(
                  eq(projects.ownerId, ownerId),
                  value.projectId ? eq(tasks.projectId, value.projectId) : undefined,
                  nameFilter,
                  value.title
                    ? sql`${tasks.title} ilike ${literal(value.title)} escape '!'`
                    : undefined,
                  value.status === "pending"
                    ? ne(tasks.status, "done")
                    : value.status
                      ? eq(tasks.status, value.status)
                      : undefined,
                  value.priority === undefined
                    ? undefined
                    : value.priority === null
                      ? isNull(tasks.priority)
                      : eq(tasks.priority, value.priority),
                  value.dueDateFrom ? gte(tasks.dueDate, value.dueDateFrom) : undefined,
                  value.dueDateTo ? lte(tasks.dueDate, value.dueDateTo) : undefined,
                  value.overdueBefore
                    ? and(lt(tasks.dueDate, value.overdueBefore), ne(tasks.status, "done"))
                    : undefined,
                ),
              )
              .orderBy(desc(tasks.updatedAt), desc(tasks.id))
              .limit(11);
            return {
              items: rows.slice(0, 10),
              truncated: rows.length > 10,
              ambiguousProject: candidates.length > 1,
            };
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        ),
      );
    },
    updateTask(input: unknown) {
      return run(contracts.updateTaskInput, input, (value, ownerId) =>
        db.transaction((tx) => updateTaskInTransaction(tx, value, ownerId), {
          isolationLevel: "read committed",
        }),
      );
    },
    deleteTask(input: unknown) {
      return run(contracts.deleteTaskInput, input, (value, ownerId) =>
        db.transaction(
          async (tx) => {
            const task = await lockTask(tx, value.taskId, ownerId);
            if (task.version !== value.expectedVersion) throw taskConflict();
            const [deleted] = await tx
              .delete(tasks)
              .where(and(ownedTask(task.id, ownerId), eq(tasks.version, value.expectedVersion)))
              .returning({ id: tasks.id, projectId: tasks.projectId });
            if (!deleted) throw taskConflict();
            return deleted;
          },
          { isolationLevel: "read committed" },
        ),
      );
    },
    confirmManagementProposal(input: unknown) {
      return run(confirmManagementProposalInput, input, (value, ownerId) =>
        db.transaction(
          async (tx) => {
            const changed = () =>
              new WorkspaceError(
                "CONFLICT",
                "This proposal has changed. Reload it before retrying.",
              );
            const sourceCondition = and(
              ownedConversation(ownerId),
              eq(chatMessages.role, "assistant"),
              eq(chatMessages.status, "completed"),
            );
            const [source] = await tx
              .select({ conversationId: chatMessages.conversationId })
              .from(managementProposals)
              .innerJoin(chatMessages, eq(chatMessages.id, managementProposals.sourceMessageId))
              .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
              .where(and(eq(managementProposals.id, value.proposalId), sourceCondition));
            if (!source) throw missing();
            const [conversation] = await tx
              .select({ id: chatConversations.id, projectId: chatConversations.projectId })
              .from(chatConversations)
              .where(
                and(eq(chatConversations.id, source.conversationId), ownedConversation(ownerId)),
              )
              .for("share", { of: chatConversations });
            if (!conversation) throw missing();
            const [row] = await tx
              .select({
                id: managementProposals.id,
                kind: managementProposals.kind,
                status: managementProposals.status,
                draft: managementProposals.draft,
                receipt: managementProposals.receipt,
                confirmedAt: managementProposals.confirmedAt,
                sourceRefs: chatMessages.sourceRefs,
                mixed: exists(
                  tx
                    .select({ id: noteProposals.id })
                    .from(noteProposals)
                    .where(eq(noteProposals.sourceMessageId, chatMessages.id)),
                ),
              })
              .from(managementProposals)
              .innerJoin(chatMessages, eq(chatMessages.id, managementProposals.sourceMessageId))
              .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
              .where(
                and(
                  eq(managementProposals.id, value.proposalId),
                  eq(chatMessages.conversationId, conversation.id),
                  sourceCondition,
                ),
              )
              .for("update", { of: managementProposals });
            if (!row) throw missing();
            if (row.mixed) throw changed();
            const { draft, receipt } = parseManagementProposal(row, conversation.projectId);
            if (!managementReferencesMatch(draft, row.sourceRefs))
              throw new Error("Invalid stored provenance");
            if (draft.kind !== value.kind) throw changed();
            if (
              draft.kind === "update_task" &&
              (value.kind !== "update_task" ||
                value.taskId !== draft.taskId ||
                value.expectedVersion !== draft.expectedVersion)
            )
              throw changed();
            const approved = approvedManagementPayload(value);
            const replayed = receipt !== null;
            if (receipt) {
              // Replay uses immutable approval, never the current task/source contents.
              if (receipt.kind !== value.kind || !managementEqual(receipt.approved, approved))
                throw changed();
            } else {
              let nextReceipt;
              if (value.kind === "create_project") {
                if (conversation.projectId !== null || draft.kind !== "create_project")
                  throw changed();
                const project = await createProjectInTransaction(tx, value, ownerId);
                nextReceipt = {
                  schemaVersion: 1,
                  kind: value.kind,
                  approved,
                  result: { projectId: project.id },
                };
              } else if (value.kind === "update_task") {
                if (
                  draft.kind !== "update_task" ||
                  value.taskId !== draft.taskId ||
                  value.expectedVersion !== draft.expectedVersion ||
                  (conversation.projectId !== null && draft.projectId !== conversation.projectId)
                )
                  throw changed();
                await lockOwnedProject(tx, draft.projectId, ownerId);
                const task = await lockTask(tx, draft.taskId, ownerId);
                if (task.projectId !== draft.projectId) throw missing();
                const updated = await updateTaskInTransaction(
                  tx,
                  {
                    taskId: draft.taskId,
                    expectedVersion: draft.expectedVersion,
                    ...value.changes,
                  },
                  ownerId,
                  task,
                );
                nextReceipt = {
                  schemaVersion: 1,
                  kind: value.kind,
                  approved,
                  result: {
                    taskId: updated.id,
                    projectId: updated.projectId,
                    version: updated.version,
                    changed: updated.version !== task.version,
                  },
                };
              } else {
                if (draft.kind !== "create_tasks") throw changed();
                await lockOwnedProject(tx, value.projectId, ownerId);
                if (conversation.projectId !== null && value.projectId !== conversation.projectId)
                  throw changed();
                const selected = value.items.map((item) => {
                  const original = draft.items.find((original) => original.itemId === item.itemId);
                  if (
                    !original ||
                    (item.fields.sourceNoteId !== null &&
                      item.fields.sourceNoteId !== original.fields.sourceNoteId)
                  )
                    throw changed();
                  return { ...item, evidence: original.evidence };
                });
                // Evidence is checked even if the user clears sourceNoteId. Pre-lock
                // every referenced note before inserting any task, in UUID order.
                const evidence = selected.flatMap((item) =>
                  item.evidence.type === "retrieved_note" ? [item.evidence] : [],
                );
                for (const noteId of [...new Set(evidence.map((e) => e.noteId))].sort()) {
                  const [note] = await tx
                    .select({ id: notes.id, updatedAt: notes.updatedAt })
                    .from(notes)
                    .where(ownedNote(value.projectId, ownerId, noteId))
                    .for("share", { of: notes });
                  if (!note) throw missing();
                  if (
                    evidence.some(
                      (e) =>
                        e.noteId === noteId &&
                        (e.projectId !== value.projectId ||
                          e.retrievedUpdatedAt !== note.updatedAt.toISOString()),
                    )
                  )
                    throw changed();
                }
                const results = [];
                for (const item of selected) {
                  const task = await createTaskInTransaction(
                    tx,
                    { projectId: value.projectId, ...item.fields },
                    ownerId,
                  );
                  results.push({
                    itemId: item.itemId,
                    taskId: task.id,
                    projectId: task.projectId,
                    version: 1,
                  });
                }
                nextReceipt = { schemaVersion: 1, kind: value.kind, approved, results };
              }
              const validatedReceipt = managementReceiptSchema.parse(nextReceipt);
              const [updated] = await tx
                .update(managementProposals)
                .set({
                  status: "confirmed",
                  receipt: validatedReceipt,
                  confirmedAt: sql`clock_timestamp()`,
                })
                .where(
                  and(
                    eq(managementProposals.id, row.id),
                    eq(managementProposals.status, "proposed"),
                  ),
                )
                .returning({ id: managementProposals.id });
              if (!updated) throw changed();
            }
            const views = await readManagementProposals(
              tx,
              ownerId,
              eq(managementProposals.id, row.id),
            );
            const proposal = [...views.values()][0];
            if (!proposal) throw missing();
            return { proposal, replayed };
          },
          { isolationLevel: "read committed" },
        ),
      );
    },
    confirmNoteProposal(input: unknown) {
      return run(confirmNoteProposalInput, input, (value, ownerId) =>
        db.transaction(
          async (tx) => {
            // Discovery is not a lock/authorization cache. Re-read source and receipt
            // AFTER the conversation lock, then the proposal lock (READ COMMITTED).
            const [source] = await tx
              .select({ conversationId: chatMessages.conversationId })
              .from(noteProposals)
              .innerJoin(chatMessages, eq(chatMessages.id, noteProposals.sourceMessageId))
              .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
              .where(
                and(
                  eq(noteProposals.id, value.proposalId),
                  notExists(
                    tx
                      .select({ id: managementProposals.id })
                      .from(managementProposals)
                      .where(eq(managementProposals.sourceMessageId, chatMessages.id)),
                  ),
                  ownedConversation(ownerId),
                  eq(chatMessages.role, "assistant"),
                  eq(chatMessages.status, "completed"),
                ),
              );
            if (!source) throw missing();
            const [conversation] = await tx
              .select({ id: chatConversations.id, projectId: chatConversations.projectId })
              .from(chatConversations)
              .where(
                and(eq(chatConversations.id, source.conversationId), ownedConversation(ownerId)),
              )
              .for("share", { of: chatConversations });
            if (!conversation) throw missing();
            const [proposal] = await tx
              .select({
                id: noteProposals.id,
                status: noteProposals.status,
                noteId: noteProposals.noteId,
                projectId: noteProposals.approvedProjectId,
                title: noteProposals.approvedTitle,
                content: noteProposals.approvedContent,
                noteDate: noteProposals.approvedNoteDate,
              })
              .from(noteProposals)
              .innerJoin(chatMessages, eq(chatMessages.id, noteProposals.sourceMessageId))
              .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
              .where(
                and(
                  eq(noteProposals.id, value.proposalId),
                  notExists(
                    tx
                      .select({ id: managementProposals.id })
                      .from(managementProposals)
                      .where(eq(managementProposals.sourceMessageId, chatMessages.id)),
                  ),
                  eq(chatMessages.conversationId, conversation.id),
                  ownedConversation(ownerId),
                  eq(chatMessages.role, "assistant"),
                  eq(chatMessages.status, "completed"),
                ),
              )
              .for("update", { of: noteProposals });
            if (!proposal) throw missing();
            // Validate ownership before returning a scope conflict: foreign/missing
            // final projects both deny identically, without exposing their existence.
            if (conversation.projectId && conversation.projectId !== value.projectId) {
              await lockOwnedProject(tx, value.projectId, ownerId);
              throw conflict();
            }
            let noteId: string;
            const replayed = proposal.status === "confirmed";
            if (replayed) {
              await lockOwnedProject(tx, value.projectId, ownerId);
              if (
                proposal.projectId !== value.projectId ||
                proposal.title !== value.title ||
                proposal.content !== value.content ||
                proposal.noteDate !== value.noteDate
              )
                throw conflict();
              if (!proposal.noteId) throw missing();
              const [note] = await tx
                .select({ id: notes.id })
                .from(notes)
                .where(ownedNote(value.projectId, ownerId, proposal.noteId));
              if (!note) throw missing();
              noteId = note.id;
            } else {
              if (proposal.status !== "proposed") throw conflict();
              const note = await createNoteInTransaction(tx, value, ownerId);
              noteId = note.id;
              const [receipt] = await tx
                .update(noteProposals)
                .set({
                  status: "confirmed",
                  noteId,
                  approvedProjectId: value.projectId,
                  approvedTitle: value.title,
                  approvedContent: value.content,
                  approvedNoteDate: value.noteDate,
                  confirmedAt: sql`clock_timestamp()`,
                })
                .where(and(eq(noteProposals.id, proposal.id), eq(noteProposals.status, "proposed")))
                .returning({ id: noteProposals.id });
              if (!receipt) throw conflict(); // Also rolls back the inserted note.
            }
            return {
              proposalId: proposal.id,
              noteId,
              projectId: value.projectId,
              href: `/projects/${value.projectId}/notes/${noteId}`,
              replayed,
            };
          },
          { isolationLevel: "read committed" },
        ),
      );
    },
    listProjects(input: unknown = {}) {
      return run(contracts.listProjectsInput, input, async (value, ownerId) =>
        db
          .select(projectFields)
          .from(projects)
          .where(eq(projects.ownerId, ownerId))
          .orderBy(desc(projects.updatedAt), desc(projects.id))
          .limit(value.limit)
          .offset(value.offset),
      );
    },
    getProject(input: unknown) {
      return run(contracts.projectInput, input, async (value, ownerId) => {
        const [project] = await db
          .select(projectFields)
          .from(projects)
          .where(ownedProject(value.projectId, ownerId));
        if (!project) throw missing();
        return project;
      });
    },
    createProject(input: unknown) {
      return run(contracts.createProjectInput, input, (value, ownerId) =>
        createProjectInTransaction(db, value, ownerId),
      );
    },
    updateProject(input: unknown) {
      return run(contracts.updateProjectInput, input, async (value, ownerId) => {
        const [project] = await db
          .update(projects)
          .set({ name: value.name, description: value.description, updatedAt: new Date() })
          .where(ownedProject(value.projectId, ownerId))
          .returning(projectFields);
        if (!project) throw missing();
        return project;
      });
    },
    listNotes(input: unknown) {
      return run(contracts.listNotesInput, input, async (value, ownerId) => {
        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(ownedProject(value.projectId, ownerId));
        if (!project) throw missing();
        // List summaries rather than returning every potentially large note body.
        return db
          .select({
            id: notes.id,
            projectId: notes.projectId,
            title: notes.title,
            noteDate: notes.noteDate,
            createdAt: notes.createdAt,
            updatedAt: notes.updatedAt,
          })
          .from(notes)
          .where(ownedNote(value.projectId, ownerId))
          .orderBy(desc(notes.updatedAt), desc(notes.id))
          .limit(value.limit)
          .offset(value.offset);
      });
    },
    searchNotes(input: unknown) {
      return run(contracts.searchNotesInput, input, async (value, ownerId) => {
        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(ownedProject(value.projectId, ownerId));
        if (!project) throw missing();
        // Explicit LIKE escape: %, _ and ! are literal; backslashes stay literal.
        const pattern = `%${value.query.replace(/[!%_]/g, "!$&")}%`;
        const titleMatch = sql<boolean>`${notes.title} ilike ${pattern} escape '!'`;
        const contentMatch = sql<boolean>`${notes.content} ilike ${pattern} escape '!'`;
        return db
          .select({
            id: notes.id,
            projectId: notes.projectId,
            title: notes.title,
            // At most 320 PostgreSQL characters, with up to 80 before the first
            // content match. Title-only matches use the beginning of the body.
            excerpt:
              sql<string>`substring(${notes.content} from greatest(1, strpos(lower(${notes.content}), lower(${value.query})) - 80) for 320)`.as(
                "excerpt",
              ),
            noteDate: notes.noteDate,
            updatedAt: notes.updatedAt,
          })
          .from(notes)
          .where(and(ownedNote(value.projectId, ownerId), or(titleMatch, contentMatch)))
          .orderBy(desc(titleMatch), desc(notes.updatedAt), desc(notes.id))
          .limit(value.limit)
          .offset(value.offset);
      });
    },
    searchOwnedNotes(input: unknown) {
      return run(contracts.searchOwnedNotesInput, input, async (value, ownerId) => {
        const pattern = `%${value.query.replace(/[!%_]/g, "!$&")}%`;
        const titleMatch = sql<boolean>`${notes.title} ilike ${pattern} escape '!'`;
        const contentMatch = sql<boolean>`${notes.content} ilike ${pattern} escape '!'`;
        // One statement scopes both matches and project metadata to the fresh
        // session owner. Missing/foreign project filters are indistinguishable.
        return db
          .select({
            id: notes.id,
            projectId: notes.projectId,
            projectName: projects.name,
            title: notes.title,
            excerpt:
              sql<string>`substring(${notes.content} from greatest(1, strpos(lower(${notes.content}), lower(${value.query})) - 80) for 320)`.as(
                "excerpt",
              ),
            noteDate: notes.noteDate,
            updatedAt: notes.updatedAt,
          })
          .from(notes)
          .innerJoin(projects, eq(projects.id, notes.projectId))
          .where(
            and(
              eq(projects.ownerId, ownerId),
              value.projectId ? eq(notes.projectId, value.projectId) : undefined,
              or(titleMatch, contentMatch),
            ),
          )
          .orderBy(desc(titleMatch), desc(notes.updatedAt), desc(notes.id))
          .limit(value.limit)
          .offset(value.offset);
      });
    },
    getNote(input: unknown) {
      return run(contracts.noteInput, input, async (value, ownerId) => {
        const [note] = await db
          .select({ ...noteFields, version: currentVersion })
          .from(notes)
          .where(ownedNote(value.projectId, ownerId, value.noteId));
        if (!note) throw missing();
        return note;
      });
    },
    createNote(input: unknown) {
      return run(contracts.createNoteInput, input, async (value, ownerId) =>
        db.transaction((tx) => createNoteInTransaction(tx, value, ownerId)),
      );
    },
    updateNote(input: unknown) {
      return run(contracts.updateNoteInput, input, async (value, ownerId) =>
        db.transaction(
          async (tx) => {
            const scope = ownedNote(value.projectId, ownerId, value.noteId);
            const [note] = await tx
              .select(noteFields)
              .from(notes)
              .where(scope)
              .for("update", { of: notes });
            if (!note) throw missing();
            // Separate statement AFTER acquiring the row lock: READ COMMITTED sees
            // snapshots committed by any writer we waited for, not its old MVCC view.
            const [history] = await tx
              .select({ lastVersion: max(noteRevisions.version) })
              .from(noteRevisions)
              .where(eq(noteRevisions.noteId, note.id));
            const version = (history?.lastVersion ?? 0) + 1;
            if (value.expectedVersion !== version) throw conflict();
            const next = {
              title: value.title ?? note.title,
              content: value.content ?? note.content,
              noteDate: value.noteDate === undefined ? note.noteDate : value.noteDate,
            };
            if (
              next.title === note.title &&
              next.content === note.content &&
              next.noteDate === note.noteDate
            )
              return { ...note, version };
            if (version >= 2_147_483_647) throw conflict();
            await tx.insert(noteRevisions).values({
              noteId: note.id,
              version,
              title: note.title,
              content: note.content,
              noteDate: note.noteDate,
            });
            const [updated] = await tx
              .update(notes)
              .set({ ...next, updatedAt: new Date() })
              .where(scope)
              .returning(noteFields);
            if (!updated) throw missing(); // Throw inside the transaction to roll back the snapshot.
            return { ...updated, version: version + 1 };
          },
          { isolationLevel: "read committed" },
        ),
      );
    },
  };
}
