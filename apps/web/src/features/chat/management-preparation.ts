import { z } from "zod";
import {
  managementDraftSchema,
  managementTaskFields,
  MANAGEMENT_BATCH_LIMIT,
  type ManagementDraft,
} from "./management-contracts";

const project = managementDraftSchema.options[0];
export const prepareProjectInput = project.pick({ name: true, description: true });
export const prepareTasksInput = z.strictObject({
  items: z
    .array(
      z.strictObject({
        ...managementTaskFields.omit({ sourceNoteId: true }).shape,
        evidence: z.discriminatedUnion("type", [
          z.strictObject({ type: z.literal("user_message") }),
          z.strictObject({
            type: z.literal("retrieved_note"),
            ordinal: z.number().int().min(1).max(5),
          }),
        ]),
      }),
    )
    .min(1)
    .max(MANAGEMENT_BATCH_LIMIT),
});
type Reference = { id: string; projectId: string; updatedAt: string; excerpt: string };
// Pure canonicalization from this turn's trusted retrieval, never model IDs.
export function prepareManagementDraft(
  kind: "prepareProject" | "prepareTasks",
  input: unknown,
  projectId: string | null,
  user: string,
  notes: Reference[] = [],
): ManagementDraft {
  if (kind === "prepareProject") {
    if (projectId !== null) throw new Error("Project preparation is Main Chat only");
    return managementDraftSchema.parse({
      schemaVersion: 1,
      kind: "create_project",
      ...prepareProjectInput.parse(input),
    });
  }
  const parsed = prepareTasksInput.parse(input);
  const items = parsed.items.map(({ evidence, ...fields }, index) => {
    const note = evidence.type === "retrieved_note" ? notes[evidence.ordinal - 1] : undefined;
    if (
      evidence.type === "retrieved_note" &&
      (!note || (projectId !== null && note.projectId !== projectId))
    )
      throw new Error("Invalid retrieval ordinal");
    const dates: string[] = `${user}\n${note?.excerpt ?? ""}`.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
    if (fields.dueDate !== null && !dates.includes(fields.dueDate))
      throw new Error("Unsupported date");
    return {
      itemId: index + 1,
      fields: { ...fields, sourceNoteId: note?.id ?? null },
      evidence: note
        ? {
            type: "retrieved_note",
            noteId: note.id,
            projectId: note.projectId,
            retrievedUpdatedAt: note.updatedAt,
            excerptOnly: true,
          }
        : { type: "user_message" },
    };
  });
  return managementDraftSchema.parse({
    schemaVersion: 1,
    kind: "create_tasks",
    scopedProjectId: projectId,
    items,
  });
}
export const MANAGEMENT_PROPOSAL_MESSAGE =
  "Draft ready for review. No project or tasks have been saved. Confirm explicitly in the preview.";
