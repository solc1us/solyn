import type { Database } from "@solyn/db";
import { noteRevisions, notes, projects } from "@solyn/db/schema/workspace";
import { chatConversations, chatMessages } from "@solyn/db/schema/chat";
import { noteProposals } from "@solyn/db/schema/note-proposals";
import { and, desc, eq, exists, isNull, max, or, sql } from "drizzle-orm";
import { confirmNoteProposalInput } from "../chat/contracts";
import type { z } from "zod";

import * as contracts from "./contracts";
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

  return {
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
      return run(contracts.createProjectInput, input, async (value, ownerId) => {
        const [project] = await db
          .insert(projects)
          .values({ ownerId, name: value.name, description: value.description ?? null })
          .returning(projectFields);
        if (!project) throw new Error("Insert returned no project");
        return project;
      });
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
