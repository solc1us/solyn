import type { Database } from "@solyn/db";
import { noteRevisions, notes, projects } from "@solyn/db/schema/workspace";
import { and, desc, eq, exists, max, sql } from "drizzle-orm";
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

  return {
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
        db.transaction(async (tx) => {
          const [project] = await tx
            .select({ id: projects.id })
            .from(projects)
            .where(ownedProject(value.projectId, ownerId))
            .for("share");
          if (!project) throw missing();
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
        }),
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
