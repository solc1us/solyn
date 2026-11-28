import { z } from "zod";

import { createProjectInput, createTaskInput, updateTaskInput, uuid } from "../workspace/contracts";
import { isChatText, sourceRefsSchema } from "./contracts";

export const MANAGEMENT_BATCH_LIMIT = 5;
export const MANAGEMENT_JSON_BYTES = 65_536;
const bounded = <S extends z.ZodType>(schema: S) =>
  schema.refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= MANAGEMENT_JSON_BYTES,
    "Proposal is too large",
  );
const version = z.number().int().min(1).max(2_147_483_647);
const itemId = z.number().int().min(1).max(MANAGEMENT_BATCH_LIMIT);
const projectFields = {
  name: createProjectInput.shape.name.refine(isChatText),
  description: createProjectInput.shape.description
    .unwrap()
    .refine((v) => v === null || isChatText(v)),
};
export const managementTaskFields = z.strictObject({
  title: createTaskInput.shape.title,
  description: createTaskInput.shape.description.unwrap(),
  status: createTaskInput.shape.status.unwrap(),
  priority: createTaskInput.shape.priority.unwrap(),
  assignee: createTaskInput.shape.assignee.unwrap(),
  dueDate: createTaskInput.shape.dueDate.unwrap(),
  sourceNoteId: createTaskInput.shape.sourceNoteId.unwrap(),
});
const {
  taskId: _taskId,
  expectedVersion: _expectedVersion,
  sourceNoteId: _sourceNoteId,
  ...changeFields
} = updateTaskInput.shape;
export const managementChanges = z
  .strictObject(changeFields)
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "Provide a task change",
  );
const timestamp = z.iso.datetime().transform((v) => new Date(v).toISOString());
const evidence = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("user_message") }),
  z.strictObject({
    type: z.literal("retrieved_note"),
    noteId: uuid,
    projectId: uuid,
    retrievedUpdatedAt: timestamp,
    excerptOnly: z.literal(true),
  }),
]);
const selected = z
  .array(z.strictObject({ itemId, fields: managementTaskFields }))
  .min(1)
  .max(MANAGEMENT_BATCH_LIMIT)
  .refine((items) => new Set(items.map((i) => i.itemId)).size === items.length)
  .transform((items) => [...items].sort((a, b) => a.itemId - b.itemId));
export const managementDraftSchema = bounded(
  z.discriminatedUnion("kind", [
    z.strictObject({
      schemaVersion: z.literal(1),
      kind: z.literal("create_project"),
      ...projectFields,
    }),
    z.strictObject({
      schemaVersion: z.literal(1),
      kind: z.literal("create_tasks"),
      scopedProjectId: uuid.nullable(),
      items: z
        .array(z.strictObject({ itemId, fields: managementTaskFields, evidence }))
        .min(1)
        .max(MANAGEMENT_BATCH_LIMIT)
        .refine((items) =>
          items.every(
            (item, index) =>
              item.itemId === index + 1 &&
              (item.evidence.type === "user_message"
                ? item.fields.sourceNoteId === null
                : item.fields.sourceNoteId === item.evidence.noteId),
          ),
        ),
    }),
    z.strictObject({
      schemaVersion: z.literal(1),
      kind: z.literal("update_task"),
      taskId: uuid,
      projectId: uuid,
      expectedVersion: version,
      changes: managementChanges,
    }),
  ]),
);
export type ManagementDraft = z.output<typeof managementDraftSchema>;
export const confirmManagementProposalInput = bounded(
  z.discriminatedUnion("kind", [
    z.strictObject({ proposalId: uuid, kind: z.literal("create_project"), ...projectFields }),
    z.strictObject({
      proposalId: uuid,
      kind: z.literal("create_tasks"),
      projectId: uuid,
      items: selected,
    }),
    z.strictObject({
      proposalId: uuid,
      kind: z.literal("update_task"),
      taskId: uuid,
      expectedVersion: version,
      changes: managementChanges,
    }),
  ]),
);
export type ManagementConfirmation = z.output<typeof confirmManagementProposalInput>;
export function approvedManagementPayload(value: ManagementConfirmation) {
  if (value.kind === "create_project") return { name: value.name, description: value.description };
  if (value.kind === "create_tasks") return { projectId: value.projectId, items: value.items };
  return { taskId: value.taskId, expectedVersion: value.expectedVersion, changes: value.changes };
}
export const managementReceiptSchema = bounded(
  z.discriminatedUnion("kind", [
    z.strictObject({
      schemaVersion: z.literal(1),
      kind: z.literal("create_project"),
      approved: z.strictObject(projectFields),
      result: z.strictObject({ projectId: uuid }),
    }),
    z
      .strictObject({
        schemaVersion: z.literal(1),
        kind: z.literal("create_tasks"),
        approved: z.strictObject({ projectId: uuid, items: selected }),
        results: z
          .array(z.strictObject({ itemId, taskId: uuid, projectId: uuid, version: z.literal(1) }))
          .min(1)
          .max(MANAGEMENT_BATCH_LIMIT),
      })
      .refine(
        (v) =>
          v.results.length === v.approved.items.length &&
          new Set(v.results.map((r) => r.taskId)).size === v.results.length &&
          v.results.every(
            (r, index) =>
              r.itemId === v.approved.items[index]?.itemId && r.projectId === v.approved.projectId,
          ),
      ),
    z
      .strictObject({
        schemaVersion: z.literal(1),
        kind: z.literal("update_task"),
        approved: z.strictObject({
          taskId: uuid,
          expectedVersion: version,
          changes: managementChanges,
        }),
        result: z.strictObject({ taskId: uuid, projectId: uuid, version, changed: z.boolean() }),
      })
      .refine(
        (v) =>
          v.result.taskId === v.approved.taskId &&
          v.result.version === v.approved.expectedVersion + (v.result.changed ? 1 : 0),
      ),
  ]),
);
export type ManagementReceipt = z.output<typeof managementReceiptSchema>;
// Canonical object-key order is not an idempotency condition (notably JSONB).
export function managementEqual(a: unknown, b: unknown): boolean {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, stable(x)]),
          )
        : v;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
export const getManagementProposalInput = z.strictObject({ proposalId: uuid });
// Internal only. The trusted orchestrator supplies server-resolved references;
// no client action, model tool or stream request accepts this contract.
export const completeManagementProposalInput = z.strictObject({
  conversationId: uuid,
  turnId: uuid,
  content: z
    .string()
    .min(1)
    .max(100_000)
    .refine((v) => !!v.trim() && isChatText(v)),
  draft: managementDraftSchema,
  sourceRefs: sourceRefsSchema.nullable().default(null),
});

const unavailable = z.strictObject({ state: z.literal("unavailable") });
const sourceView = z.discriminatedUnion("state", [
  unavailable,
  z
    .strictObject({
      state: z.literal("available"),
      noteId: uuid,
      projectId: uuid,
      retrievedUpdatedAt: timestamp,
      updatedAt: timestamp,
      href: z.string(),
    })
    .refine((v) => v.href === `/projects/${v.projectId}/notes/${v.noteId}`),
]);
export const managementUpdateFields = managementTaskFields.omit({ sourceNoteId: true });
const updateResult = z.discriminatedUnion("state", [
  unavailable,
  z
    .strictObject({
      state: z.literal("available"),
      taskId: uuid,
      projectId: uuid,
      href: z.string(),
      currentVersion: version,
    })
    .refine((v) => v.href === `/tasks/${v.taskId}`),
]);
const updateTarget = z.discriminatedUnion("state", [
  unavailable,
  z
    .strictObject({
      state: z.literal("available"),
      taskId: uuid,
      projectId: uuid,
      projectName: projectFields.name,
      href: z.string(),
      currentVersion: version,
      fields: managementUpdateFields,
    })
    .refine((v) => v.href === `/tasks/${v.taskId}`),
]);
const publicDraft = z.discriminatedUnion("kind", [
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("create_project"),
    ...projectFields,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("create_tasks"),
    scopedProjectId: uuid.nullable(),
    items: z
      .array(
        z.strictObject({
          itemId,
          fields: managementTaskFields,
          evidence: z.discriminatedUnion("type", [
            z.strictObject({ type: z.literal("user_message") }),
            z.strictObject({
              type: z.literal("retrieved_note"),
              excerptOnly: z.literal(true),
              source: sourceView,
            }),
          ]),
        }),
      )
      .min(1)
      .max(5),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("update_task"),
    expectedVersion: version,
    changes: managementChanges,
    target: updateTarget,
  }),
]);
const projectResult = z.discriminatedUnion("state", [
  unavailable,
  z
    .strictObject({ state: z.literal("available"), projectId: uuid, href: z.string() })
    .refine((v) => v.href === `/projects/${v.projectId}`),
]);
const taskResult = z.discriminatedUnion("state", [
  unavailable.extend({ itemId }),
  z
    .strictObject({
      itemId,
      state: z.literal("available"),
      taskId: uuid,
      projectId: uuid,
      href: z.string(),
      currentVersion: version,
    })
    .refine((v) => v.href === `/tasks/${v.taskId}`),
]);
export const managementProposalViewSchema = z
  .strictObject({
    id: uuid,
    sourceMessageId: uuid,
    conversationId: uuid,
    turnId: uuid,
    kind: z.enum(["create_project", "create_tasks", "update_task"]),
    status: z.enum(["proposed", "confirmed"]),
    draft: publicDraft,
    scopedProject: z.strictObject({ id: uuid, name: projectFields.name }).nullable(),
    receipt: z
      .discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("create_project"), result: projectResult }),
        z.strictObject({
          kind: z.literal("create_tasks"),
          results: z.array(taskResult).min(1).max(5),
        }),
        z.strictObject({
          kind: z.literal("update_task"),
          result: updateResult,
          version,
          changed: z.boolean(),
        }),
      ])
      .nullable(),
  })
  .refine(
    (v) =>
      v.kind === v.draft.kind &&
      (v.status === "confirmed") === (v.receipt !== null) &&
      (!v.receipt || v.kind === v.receipt.kind),
  );
export type ManagementProposalView = z.output<typeof managementProposalViewSchema>;
