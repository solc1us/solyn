import { z } from "zod";

import { createNoteInput, createProjectInput, searchNotesInput } from "../workspace/contracts";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAVAILABLE";
export type ChatResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string } };

const uuid = z.uuid().transform((value) => value.toLowerCase());
// Preserve the original message, including whitespace. Only titles are trimmed.
const content = z
  .string()
  .min(1)
  .max(100_000)
  .refine((value) => value.trim().length > 0);
const pagination = {
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(100_000).default(0),
};
const turn = { conversationId: uuid, turnId: uuid };
export const createConversationInput = z.strictObject({
  title: z.string().trim().min(1).max(300),
  projectId: uuid.nullable().default(null),
});
export const listConversationsInput = z.strictObject({ ...pagination, projectId: uuid.optional() });
export const getConversationInput = z.strictObject({
  conversationId: uuid,
  ...pagination,
  latest: z.boolean().default(false),
});
export const beginTurnInput = z.strictObject({
  ...turn,
  content,
  modelId: z.string().trim().min(1).max(200).nullable().default(null),
});
export const CHAT_INPUT_LIMIT = 4000;
export function isChatText(value: string) {
  // PostgreSQL text cannot store NUL. Unicode mode matches only lone surrogates,
  // not valid pairs, without requiring String.isWellFormed in the browser.
  return !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value);
}
export const streamTurnInput = beginTurnInput
  .pick({ conversationId: true, turnId: true, content: true })
  .extend({ content: content.max(CHAT_INPUT_LIMIT).refine(isChatText) });
const sourceTimestamp = z.iso.datetime().transform((value) => new Date(value).toISOString());
// Private server completion metadata, never accepted by streamTurnInput or model tools.
export const sourceRefsSchema = z
  .array(z.strictObject({ noteId: uuid, projectId: uuid, retrievedUpdatedAt: sourceTimestamp }))
  .min(1)
  .max(5)
  .refine((refs) => new Set(refs.map((ref) => ref.noteId)).size === refs.length);
export type SourceRef = z.output<typeof sourceRefsSchema>[number];
export const sourcesSchema = z
  .array(
    z.discriminatedUnion("state", [
      z.strictObject({
        ordinal: z.number().int().min(1).max(5),
        state: z.literal("available"),
        noteId: uuid,
        projectId: uuid,
        projectName: createProjectInput.shape.name.refine(isChatText),
        title: createNoteInput.shape.title.refine(isChatText),
        href: z.string(),
        retrievedUpdatedAt: sourceTimestamp,
        updatedAt: sourceTimestamp,
      }),
      z.strictObject({ ordinal: z.number().int().min(1).max(5), state: z.literal("unavailable") }),
    ]),
  )
  .max(5)
  .refine(
    (sources) =>
      sources.every(
        (source, index) =>
          source.ordinal === index + 1 &&
          (source.state === "unavailable" ||
            source.href === `/projects/${source.projectId}/notes/${source.noteId}`),
      ) &&
      new Set(
        sources.filter((source) => source.state === "available").map((source) => source.noteId),
      ).size === sources.filter((source) => source.state === "available").length,
  );
export type SourceView = z.output<typeof sourcesSchema>[number];
export const completeResponseInput = z.strictObject({
  ...turn,
  content,
  sourceRefs: sourceRefsSchema.nullable().default(null),
});
export const endResponseInput = z.strictObject({
  ...turn,
  // Failed/stopped output may be empty or partial, but must never contain raw errors.
  content: z.string().max(100_000).optional(),
});
// Shared note validation, with no model-controlled identity or write capability.
export const prepareNoteInput = z.strictObject({
  projectHint: z.string().trim().min(1).max(200).refine(isChatText).nullable(),
  title: createNoteInput.shape.title.refine(isChatText),
  content: createNoteInput.shape.content.refine(isChatText),
  noteDate: createNoteInput.shape.noteDate.unwrap(),
});
// The conversation, not the model, supplies project scope and pagination.
export const searchNotesToolInput = searchNotesInput.pick({ query: true });
export const confirmNoteProposalInput = z.strictObject({
  proposalId: uuid,
  projectId: uuid,
  title: prepareNoteInput.shape.title,
  content: prepareNoteInput.shape.content,
  noteDate: prepareNoteInput.shape.noteDate,
});
export type ConfirmNoteProposalInput = z.infer<typeof confirmNoteProposalInput>;
export const confirmationReceiptSchema = z
  .strictObject({
    proposalId: uuid,
    noteId: uuid,
    projectId: uuid,
    href: z.string(),
    replayed: z.boolean(),
  })
  .refine((value) => value.href === `/projects/${value.projectId}/notes/${value.noteId}`);
export type NoteDraft = z.infer<typeof prepareNoteInput>;
export const completeProposalInput = z.strictObject({ ...turn, content, draft: prepareNoteInput });
export const proposalViewSchema = z
  .strictObject({
    id: uuid,
    sourceMessageId: uuid,
    conversationId: uuid,
    turnId: uuid,
    status: z.enum(["proposed", "confirmed"]),
    draft: prepareNoteInput,
    scopedProject: z
      .strictObject({ id: uuid, name: z.string().max(200).refine(isChatText) })
      .nullable(),
    receipt: z.strictObject({ noteId: uuid, projectId: uuid, href: z.string() }).nullable(),
  })
  .superRefine((value, context) => {
    if ((value.status === "confirmed") !== (value.receipt !== null))
      context.addIssue({ code: "custom", message: "Invalid proposal receipt." });
    if (
      value.receipt &&
      value.receipt.href !== `/projects/${value.receipt.projectId}/notes/${value.receipt.noteId}`
    )
      context.addIssue({ code: "custom", message: "Invalid note link." });
  });
export type ProposalView = z.infer<typeof proposalViewSchema>;
export const getProposalInput = z.strictObject({ proposalId: uuid });
export const PROPOSAL_MESSAGE = "Draft ready for review. No note has been saved.";

// Until a reviewed date parser exists, accept only a literal ISO date from the
// current user message. Unknown/relative dates stay null and can be edited locally.
export function proposalMatchesContext(
  draft: NoteDraft,
  userContent: string,
  projectName: string | null,
) {
  const dates: string[] = userContent.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
  return (
    (!draft.noteDate || dates.includes(draft.noteDate)) &&
    (!projectName ||
      !draft.projectHint ||
      draft.projectHint.toLowerCase() === projectName.trim().toLowerCase())
  );
}

export const recoverTurnInput = z.strictObject(turn);
export const generationContextInput = z.strictObject(turn);

export type CreateConversationInput = z.input<typeof createConversationInput>;
export type BeginTurnInput = z.input<typeof beginTurnInput>;
export type CompleteResponseInput = z.input<typeof completeResponseInput>;
export type EndResponseInput = z.input<typeof endResponseInput>;
