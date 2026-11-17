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

export type CreateProjectInput = z.input<typeof createProjectInput>;
export type UpdateProjectInput = z.input<typeof updateProjectInput>;
export type CreateNoteInput = z.input<typeof createNoteInput>;
export type UpdateNoteInput = z.input<typeof updateNoteInput>;
