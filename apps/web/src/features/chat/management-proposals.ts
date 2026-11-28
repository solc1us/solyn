import type { Database } from "@solyn/db";
import { managementProposals } from "@solyn/db/schema/management-proposals";
import { noteProposals } from "@solyn/db/schema/note-proposals";
import { chatMessages, chatConversations } from "@solyn/db/schema/chat";
import { notes, projects, tasks } from "@solyn/db/schema/workspace";
import { and, eq, exists, inArray, isNull, or, type SQL } from "drizzle-orm";

import { sourceRefsSchema } from "./contracts";
import {
  managementDraftSchema,
  managementReceiptSchema,
  managementProposalViewSchema,
  type ManagementDraft,
} from "./management-contracts";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export function parseManagementProposal(
  row: {
    kind: string;
    status: string;
    draft: unknown;
    receipt: unknown;
    confirmedAt: Date | null;
  },
  scopeId: string | null,
) {
  const draft = managementDraftSchema.parse(row.draft);
  const receipt = row.receipt === null ? null : managementReceiptSchema.parse(row.receipt);
  if (
    row.kind !== draft.kind ||
    draft.kind === "update_task" ||
    (draft.kind === "create_project" && scopeId !== null) ||
    (draft.kind === "create_tasks" &&
      (draft.scopedProjectId !== scopeId ||
        (scopeId !== null && managementEvidence(draft).some((e) => e.projectId !== scopeId)))) ||
    (row.status !== "proposed" && row.status !== "confirmed") ||
    (row.status === "confirmed") !== (receipt !== null) ||
    (row.status === "confirmed") !== (row.confirmedAt !== null) ||
    (receipt && receipt.kind !== draft.kind)
  )
    throw new Error("Invalid stored management proposal");
  if (receipt?.kind === "create_tasks" && draft.kind === "create_tasks") {
    if (
      (scopeId && receipt.approved.projectId !== scopeId) ||
      receipt.approved.items.some((item) => {
        const original = draft.items.find((i) => i.itemId === item.itemId);
        return (
          !original ||
          (item.fields.sourceNoteId !== null &&
            item.fields.sourceNoteId !== original.fields.sourceNoteId) ||
          (original.evidence.type === "retrieved_note" &&
            original.evidence.projectId !== receipt.approved.projectId)
        );
      })
    )
      throw new Error("Invalid stored selection");
  }
  return { draft, receipt };
}

export function managementEvidence(draft: ManagementDraft) {
  return draft.kind === "create_tasks"
    ? draft.items.flatMap((item) =>
        item.evidence.type === "retrieved_note" ? [item.evidence] : [],
      )
    : [];
}
export function managementReferencesMatch(draft: ManagementDraft, refs: unknown) {
  const parsed = sourceRefsSchema.nullable().parse(refs);
  return managementEvidence(draft).every((evidence) =>
    parsed?.some(
      (ref) =>
        ref.noteId === evidence.noteId &&
        ref.projectId === evidence.projectId &&
        ref.retrievedUpdatedAt === evidence.retrievedUpdatedAt,
    ),
  );
}

// Shared read-only projection for chat history/replay and workspace confirmation.
// All queries are bounded by a message page (or one proposal); no per-item reads.
export async function readManagementProposals(tx: Transaction, ownerId: string, condition: SQL) {
  const rows = await tx
    .select({
      id: managementProposals.id,
      sourceMessageId: managementProposals.sourceMessageId,
      kind: managementProposals.kind,
      status: managementProposals.status,
      draft: managementProposals.draft,
      receipt: managementProposals.receipt,
      confirmedAt: managementProposals.confirmedAt,
      conversationId: chatMessages.conversationId,
      turnId: chatMessages.turnId,
      scopeId: chatConversations.projectId,
      scopeName: projects.name,
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
    .leftJoin(projects, eq(projects.id, chatConversations.projectId))
    .where(
      and(
        condition,
        eq(chatConversations.ownerId, ownerId),
        eq(chatMessages.role, "assistant"),
        eq(chatMessages.status, "completed"),
        or(
          isNull(chatConversations.projectId),
          and(eq(projects.id, chatConversations.projectId), eq(projects.ownerId, ownerId)),
        ),
      ),
    );
  const parsed = rows.map((row) => {
    if (row.mixed) throw new Error("Mixed proposals");
    const data = parseManagementProposal(row, row.scopeId);
    if (!managementReferencesMatch(data.draft, row.sourceRefs))
      throw new Error("Invalid stored provenance");
    return { ...row, ...data };
  });
  const noteIds = [
    ...new Set(parsed.flatMap((row) => managementEvidence(row.draft).map((e) => e.noteId))),
  ];
  const taskIds = [
    ...new Set(
      parsed.flatMap((row) =>
        row.receipt?.kind === "create_tasks" ? row.receipt.results.map((r) => r.taskId) : [],
      ),
    ),
  ];
  const projectIds = [
    ...new Set(
      parsed.flatMap((row) =>
        row.receipt?.kind === "create_project" ? [row.receipt.result.projectId] : [],
      ),
    ),
  ];
  const foundNotes = noteIds.length
    ? await tx
        .select({ id: notes.id, projectId: notes.projectId, updatedAt: notes.updatedAt })
        .from(notes)
        .innerJoin(projects, eq(projects.id, notes.projectId))
        .where(and(inArray(notes.id, noteIds), eq(projects.ownerId, ownerId)))
    : [];
  const foundTasks = taskIds.length
    ? await tx
        .select({ id: tasks.id, projectId: tasks.projectId, version: tasks.version })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(inArray(tasks.id, taskIds), eq(projects.ownerId, ownerId)))
    : [];
  const foundProjects = projectIds.length
    ? await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(inArray(projects.id, projectIds), eq(projects.ownerId, ownerId)))
    : [];
  const result = new Map<string, ReturnType<typeof managementProposalViewSchema.parse>>();
  for (const row of parsed) {
    const draft =
      row.draft.kind === "create_tasks"
        ? {
            ...row.draft,
            items: row.draft.items.map((item) => {
              if (item.evidence.type === "user_message") return item;
              const evidence = item.evidence;
              const note = foundNotes.find(
                (note) =>
                  note.id === evidence.noteId &&
                  note.projectId === evidence.projectId &&
                  (row.scopeId === null || note.projectId === row.scopeId),
              );
              return {
                ...item,
                fields: { ...item.fields, sourceNoteId: note ? item.fields.sourceNoteId : null },
                evidence: {
                  type: "retrieved_note",
                  excerptOnly: true,
                  source: note
                    ? {
                        state: "available",
                        noteId: note.id,
                        projectId: note.projectId,
                        retrievedUpdatedAt: evidence.retrievedUpdatedAt,
                        updatedAt: note.updatedAt.toISOString(),
                        href: `/projects/${note.projectId}/notes/${note.id}`,
                      }
                    : { state: "unavailable" },
                },
              };
            }),
          }
        : row.draft;
    const savedReceipt = row.receipt;
    const receipt =
      savedReceipt?.kind === "create_project"
        ? {
            kind: "create_project",
            result: foundProjects.some((p) => p.id === savedReceipt.result.projectId)
              ? {
                  state: "available",
                  projectId: savedReceipt.result.projectId,
                  href: `/projects/${savedReceipt.result.projectId}`,
                }
              : { state: "unavailable" },
          }
        : row.receipt?.kind === "create_tasks"
          ? {
              kind: "create_tasks",
              results: row.receipt.results.map((r) => {
                const task = foundTasks.find(
                  (t) => t.id === r.taskId && t.projectId === r.projectId,
                );
                return task
                  ? {
                      itemId: r.itemId,
                      state: "available",
                      taskId: task.id,
                      projectId: task.projectId,
                      href: `/tasks/${task.id}`,
                      currentVersion: task.version,
                    }
                  : { itemId: r.itemId, state: "unavailable" };
              }),
            }
          : null;
    const view = managementProposalViewSchema.parse({
      id: row.id,
      sourceMessageId: row.sourceMessageId,
      conversationId: row.conversationId,
      turnId: row.turnId,
      kind: row.kind,
      status: row.status,
      draft,
      scopedProject: row.scopeId ? { id: row.scopeId, name: row.scopeName } : null,
      receipt,
    });
    if (result.has(row.sourceMessageId)) throw new Error("Duplicate management proposal");
    result.set(row.sourceMessageId, view);
  }
  return result;
}
