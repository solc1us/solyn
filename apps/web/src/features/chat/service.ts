import type { Database } from "@solyn/db";
import {
  chatConversations as conversations,
  chatMessages as messages,
} from "@solyn/db/schema/chat";
import { projects } from "@solyn/db/schema/workspace";
import { and, asc, desc, eq, exists, isNull, or, sql } from "drizzle-orm";
import type { z } from "zod";

import * as contracts from "./contracts";
import type { ChatResult, ErrorCode } from "./contracts";

// Phase 2C must bound provider work below this deadline; no heartbeat or worker.
export const PENDING_TIMEOUT_MS = 10 * 60 * 1000;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Message = typeof messages.$inferSelect;
class ChatError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}
const missing = () => new ChatError("NOT_FOUND", "Conversation or turn not found.");
const conflict = () =>
  new ChatError(
    "CONFLICT",
    "This turn cannot be changed. Reload the conversation before continuing.",
  );
const conversationFields = {
  id: conversations.id,
  projectId: conversations.projectId,
  title: conversations.title,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
};
const messageFields = {
  id: messages.id,
  conversationId: messages.conversationId,
  turnId: messages.turnId,
  role: messages.role,
  content: messages.content,
  status: messages.status,
  modelId: messages.modelId,
  createdAt: messages.createdAt,
  updatedAt: messages.updatedAt,
};
const abandoned = (message: Message, now: Date) =>
  message.status === "pending" && now.getTime() - message.createdAt.getTime() >= PENDING_TIMEOUT_MS;

// Internal composition seam. Only server.ts supplies the real DB/session; never
// accept a caller/model-provided owner or expose this factory as a Server Action.
export function createChatService({
  db,
  getSession,
}: {
  db: Database;
  getSession: () => Promise<{ user: { id: string } } | null>;
}) {
  const owned = (ownerId: string, conversationId?: string) =>
    and(
      eq(conversations.ownerId, ownerId),
      conversationId ? eq(conversations.id, conversationId) : undefined,
      or(
        isNull(conversations.projectId),
        exists(
          db
            .select({ id: projects.id })
            .from(projects)
            .where(and(eq(projects.id, conversations.projectId), eq(projects.ownerId, ownerId))),
        ),
      ),
    );
  const ownedMessages = (ownerId: string, conversationId: string) =>
    and(
      eq(messages.conversationId, conversationId),
      exists(
        db
          .select({ id: conversations.id })
          .from(conversations)
          .where(owned(ownerId, conversationId)),
      ),
    );

  async function run<S extends z.ZodType, T>(
    schema: S,
    input: unknown,
    work: (value: z.output<S>, ownerId: string) => Promise<T>,
  ): Promise<ChatResult<T>> {
    try {
      const session = await getSession();
      if (!session?.user.id) throw new ChatError("UNAUTHENTICATED", "Sign in to continue.");
      const parsed = schema.safeParse(input);
      if (!parsed.success)
        throw new ChatError("INVALID_INPUT", "Check the supplied fields and try again.");
      return { ok: true, data: await work(parsed.data, session.user.id) };
    } catch (error) {
      if (error instanceof ChatError)
        return { ok: false, error: { code: error.code, message: error.message } };
      // No logging or serialization of driver errors, SQL, credentials or messages.
      return {
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Chat history is unavailable. Check the conversation before retrying.",
        },
      };
    }
  }

  async function databaseNow(tx: Transaction) {
    const result = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    const now = new Date(result.rows[0]!.now);
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid database clock");
    return now;
  }
  async function lock(tx: Transaction, ownerId: string, conversationId: string) {
    const [conversation] = await tx
      .select(conversationFields)
      .from(conversations)
      .where(owned(ownerId, conversationId))
      .for("update", { of: conversations });
    if (!conversation) throw missing();
    return conversation;
  }
  async function touch(tx: Transaction, ownerId: string, conversationId: string, updatedAt: Date) {
    const [row] = await tx
      .update(conversations)
      .set({ updatedAt })
      .where(owned(ownerId, conversationId))
      .returning({ id: conversations.id });
    if (!row) throw missing();
  }
  async function setTerminal(
    tx: Transaction,
    ownerId: string,
    message: Message,
    status: "completed" | "failed" | "stopped",
    content: string,
    now: Date,
  ) {
    const [row] = await tx
      .update(messages)
      .set({ status, content, updatedAt: now })
      .where(
        and(
          ownedMessages(ownerId, message.conversationId),
          eq(messages.id, message.id),
          eq(messages.role, "assistant"),
          eq(messages.status, "pending"),
        ),
      )
      .returning(messageFields);
    if (!row) throw conflict();
    return row;
  }
  const activityTime = (now: Date, previous: Date) =>
    new Date(Math.max(now.getTime(), previous.getTime() + 1));

  function endResponse(input: unknown, status: "completed" | "failed" | "stopped") {
    const schema =
      status === "completed" ? contracts.completeResponseInput : contracts.endResponseInput;
    return run(schema, input, async (value, ownerId) =>
      db.transaction(
        async (tx) => {
          const conversation = await lock(tx, ownerId, value.conversationId);
          const [response] = await tx
            .select(messageFields)
            .from(messages)
            .where(
              and(
                ownedMessages(ownerId, value.conversationId),
                eq(messages.turnId, value.turnId),
                eq(messages.role, "assistant"),
              ),
            );
          if (!response) throw missing();
          const content = value.content ?? response.content;
          if (response.status !== "pending") {
            if (response.status !== status || response.content !== content) throw conflict();
            return response; // Exact terminal replay, no timestamps/history rewritten.
          }
          const now = await databaseNow(tx);
          if (status === "completed" && abandoned(response, now)) throw conflict();
          const updatedAt = activityTime(now, conversation.updatedAt);
          const result = await setTerminal(tx, ownerId, response, status, content, updatedAt);
          await touch(tx, ownerId, conversation.id, updatedAt);
          return result;
        },
        { isolationLevel: "read committed" },
      ),
    );
  }

  return {
    createConversation(input: unknown) {
      return run(contracts.createConversationInput, input, async (value, ownerId) =>
        db.transaction(async (tx) => {
          if (value.projectId) {
            const [project] = await tx
              .select({ id: projects.id })
              .from(projects)
              .where(and(eq(projects.id, value.projectId), eq(projects.ownerId, ownerId)))
              .for("share");
            if (!project) throw missing();
          }
          const [conversation] = await tx
            .insert(conversations)
            .values({ ...value, ownerId })
            .returning(conversationFields);
          if (!conversation) throw new Error("Missing conversation insert");
          return conversation;
        }),
      );
    },
    listConversations(input: unknown = {}) {
      return run(contracts.listConversationsInput, input, async (value, ownerId) =>
        db
          .select(conversationFields)
          .from(conversations)
          .where(owned(ownerId))
          .orderBy(desc(conversations.updatedAt), desc(conversations.id))
          .limit(value.limit)
          .offset(value.offset),
      );
    },
    getConversation(input: unknown) {
      return run(contracts.getConversationInput, input, async (value, ownerId) =>
        db.transaction(
          async (tx) => {
            const [conversation] = await tx
              .select(conversationFields)
              .from(conversations)
              .where(owned(ownerId, value.conversationId));
            if (!conversation) throw missing();
            const page = await tx
              .select(messageFields)
              .from(messages)
              .where(ownedMessages(ownerId, conversation.id))
              .orderBy(asc(messages.createdAt), desc(messages.role), asc(messages.id))
              .limit(value.limit)
              .offset(value.offset);
            // Detect pending work even when its message lies outside the requested page.
            const [pending] = await tx
              .select(messageFields)
              .from(messages)
              .where(and(ownedMessages(ownerId, conversation.id), eq(messages.status, "pending")))
              .limit(1);
            const now = await databaseNow(tx);
            return {
              conversation,
              messages: page,
              pendingTurn: pending
                ? { turnId: pending.turnId, abandoned: abandoned(pending, now) }
                : null,
            };
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        ),
      );
    },
    beginTurn(input: unknown) {
      return run(contracts.beginTurnInput, input, async (value, ownerId) =>
        db.transaction(
          async (tx) => {
            const conversation = await lock(tx, ownerId, value.conversationId);
            // Separate statements after the lock: see commits by a writer we waited for.
            const existing = await tx
              .select(messageFields)
              .from(messages)
              .where(
                and(ownedMessages(ownerId, conversation.id), eq(messages.turnId, value.turnId)),
              );
            const now = await databaseNow(tx);
            if (existing.length) {
              const user = existing.find((row) => row.role === "user");
              const assistant = existing.find((row) => row.role === "assistant");
              if (existing.length !== 2 || !user || !assistant) throw new Error("Incomplete turn");
              if (user.content !== value.content || assistant.modelId !== value.modelId)
                throw conflict();
              return { user, assistant, replayed: true, abandoned: abandoned(assistant, now) };
            }
            const [pending] = await tx
              .select(messageFields)
              .from(messages)
              .where(and(ownedMessages(ownerId, conversation.id), eq(messages.status, "pending")))
              .limit(1);
            if (pending) {
              if (!abandoned(pending, now)) throw conflict();
              await setTerminal(tx, ownerId, pending, "failed", pending.content, now);
            }
            const createdAt = activityTime(now, conversation.updatedAt);
            const rows = await tx
              .insert(messages)
              .values([
                {
                  conversationId: conversation.id,
                  turnId: value.turnId,
                  role: "user",
                  content: value.content,
                  status: "completed",
                  modelId: null,
                  createdAt,
                  updatedAt: createdAt,
                },
                {
                  conversationId: conversation.id,
                  turnId: value.turnId,
                  role: "assistant",
                  content: "",
                  status: "pending",
                  modelId: value.modelId,
                  createdAt,
                  updatedAt: createdAt,
                },
              ])
              .returning(messageFields);
            const user = rows.find((row) => row.role === "user");
            const assistant = rows.find((row) => row.role === "assistant");
            if (rows.length !== 2 || !user || !assistant) throw new Error("Missing turn insert");
            await touch(tx, ownerId, conversation.id, createdAt);
            return { user, assistant, replayed: false, abandoned: false };
          },
          { isolationLevel: "read committed" },
        ),
      );
    },
    completeResponse(input: unknown) {
      return endResponse(input, "completed");
    },
    failResponse(input: unknown) {
      return endResponse(input, "failed");
    },
    stopResponse(input: unknown) {
      return endResponse(input, "stopped");
    },
    recoverAbandonedTurn(input: unknown) {
      return run(contracts.recoverTurnInput, input, async (value, ownerId) =>
        db.transaction(
          async (tx) => {
            const conversation = await lock(tx, ownerId, value.conversationId);
            const [response] = await tx
              .select(messageFields)
              .from(messages)
              .where(
                and(
                  ownedMessages(ownerId, conversation.id),
                  eq(messages.turnId, value.turnId),
                  eq(messages.role, "assistant"),
                ),
              );
            if (!response) throw missing();
            if (response.status !== "pending") return response;
            const now = await databaseNow(tx);
            if (!abandoned(response, now)) throw conflict();
            const updatedAt = activityTime(now, conversation.updatedAt);
            const result = await setTerminal(
              tx,
              ownerId,
              response,
              "failed",
              response.content,
              updatedAt,
            );
            await touch(tx, ownerId, conversation.id, updatedAt);
            return result;
          },
          { isolationLevel: "read committed" },
        ),
      );
    },
  };
}
