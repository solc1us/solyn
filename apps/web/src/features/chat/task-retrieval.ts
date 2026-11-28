import { z } from "zod";
import { createTaskInput, searchNotesInput, searchTasksInput, uuid } from "../workspace/contracts";
import {
  managementChanges,
  managementDraftSchema,
  managementUpdateFields,
} from "./management-contracts";
import { isChatText } from "./contracts";

const date = createTaskInput.shape.dueDate.unwrap();
export const searchTasksToolInput = z
  .strictObject({
    title: searchNotesInput.shape.query.nullable().optional(),
    projectName: searchNotesInput.shape.query.nullable().optional(),
    status: z.enum(["todo", "in_progress", "blocked", "done", "pending"]).nullable().optional(),
    priority: z.enum(["any", "none", "urgent", "high", "medium", "low"]).optional(),
    dueDateFrom: date.optional(),
    dueDateTo: date.optional(),
    overdueBefore: date.optional(),
  })
  .refine((v) => !v.dueDateFrom || !v.dueDateTo || v.dueDateFrom <= v.dueDateTo);
export const taskSearchResult = z.strictObject({
  items: z
    .array(
      z.strictObject({
        id: uuid,
        projectId: uuid,
        projectName: z.string().trim().min(1).max(200).refine(isChatText),
        title: createTaskInput.shape.title,
        description: z
          .string()
          .max(320)
          .refine((v) => isChatText(v) && [...v].length <= 160)
          .nullable(),
        status: createTaskInput.shape.status.unwrap(),
        priority: createTaskInput.shape.priority.unwrap(),
        assignee: createTaskInput.shape.assignee.unwrap(),
        dueDate: date,
        version: z.number().int().min(1).max(2_147_483_647),
      }),
    )
    .max(10)
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length),
  truncated: z.boolean(),
  ambiguousProject: z.boolean(),
});
export type TaskRetrieval = z.output<typeof taskSearchResult>;
export function literalDate(date: string, user: string) {
  return (user.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []).some((d) => d === date);
}
export function taskSearchQuery(
  input: z.output<typeof searchTasksToolInput>,
  scope: string | null,
  user: string,
) {
  if (scope && input.projectName != null) throw new Error("Project scope is fixed");
  for (const d of [input.dueDateFrom, input.dueDateTo, input.overdueBefore])
    if (d && !literalDate(d, user)) throw new Error("Provide an explicit calendar cutoff");
  return searchTasksInput.parse({
    ...(scope ? { projectId: scope } : {}),
    title: input.title ?? undefined,
    projectName: input.projectName ?? undefined,
    status: input.status ?? undefined,
    priority:
      input.priority === "any" ? undefined : input.priority === "none" ? null : input.priority,
    dueDateFrom: input.dueDateFrom ?? undefined,
    dueDateTo: input.dueDateTo ?? undefined,
    overdueBefore: input.overdueBefore ?? undefined,
  });
}
// Never send task/project IDs to the model. Identity and versions used for
// preparation come from the private, validated turn-local records, not prose.
export function taskSearchOutput(retrieval: TaskRetrieval) {
  const items = retrieval.items.map(({ id: _id, projectId: _projectId, ...item }, index) => ({
    ordinal: index + 1,
    ...item,
  }));
  while (JSON.stringify(items).length > 7600) {
    items.pop();
    retrieval.items.pop();
    retrieval.truncated = true;
  }
  return {
    status: items.length ? "found" : "empty",
    truncated: retrieval.truncated,
    ambiguousProject: retrieval.ambiguousProject,
    items,
  };
}
const updateFields = managementUpdateFields.keyof();
// Provider strict mode requires every property at every object level. Selection
// expresses omission; backend/persisted contracts remain genuinely partial.
export const prepareTaskUpdateInput = z
  .strictObject({
    ordinal: z.number().int().min(1).max(10),
    fieldsToChange: z
      .array(updateFields)
      .min(1)
      .max(6)
      .refine((fields) => new Set(fields).size === fields.length),
    changes: managementUpdateFields.extend({
      title: managementUpdateFields.shape.title.nullable(),
      status: managementUpdateFields.shape.status.nullable(),
    }),
  })
  .refine((value) =>
    value.fieldsToChange.every(
      (field) => (field !== "title" && field !== "status") || value.changes[field] !== null,
    ),
  );
export function canPrepareTaskUpdate(retrieval: TaskRetrieval | undefined) {
  return (
    !!retrieval &&
    !retrieval.truncated &&
    !retrieval.ambiguousProject &&
    retrieval.items.length === 1
  );
}
export function prepareTaskUpdate(
  input: unknown,
  retrieval: TaskRetrieval | undefined,
  user: string,
) {
  const parsed = prepareTaskUpdateInput.parse(input);
  // A narrow single match is deliberately required, including project-name
  // disambiguation. Do not silently choose one task from an ambiguous page.
  if (!canPrepareTaskUpdate(retrieval) || parsed.ordinal !== 1)
    throw new Error("Clarify the target task");
  const task = retrieval!.items[0]!;
  const changes = managementChanges.parse(
    Object.fromEntries(parsed.fieldsToChange.map((field) => [field, parsed.changes[field]])),
  );
  if (
    changes.dueDate &&
    !literalDate(changes.dueDate, `${user}\n${task.description ?? ""}\n${task.dueDate ?? ""}`)
  )
    throw new Error("Unsupported date");
  return managementDraftSchema.parse({
    schemaVersion: 1,
    kind: "update_task",
    taskId: task.id,
    projectId: task.projectId,
    expectedVersion: task.version,
    changes,
  });
}
