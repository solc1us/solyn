import { z } from "zod";

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
export const listConversationsInput = z.strictObject(pagination);
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
export const completeResponseInput = z.strictObject({ ...turn, content });
export const endResponseInput = z.strictObject({
  ...turn,
  // Failed/stopped output may be empty or partial, but must never contain raw errors.
  content: z.string().max(100_000).optional(),
});
export const recoverTurnInput = z.strictObject(turn);
export const generationContextInput = z.strictObject(turn);

export type CreateConversationInput = z.input<typeof createConversationInput>;
export type BeginTurnInput = z.input<typeof beginTurnInput>;
export type CompleteResponseInput = z.input<typeof completeResponseInput>;
export type EndResponseInput = z.input<typeof endResponseInput>;
