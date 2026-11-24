import type { Database } from "@solyn/db";
import {
  chatConversations as conversations,
  chatMessages as messages,
} from "@solyn/db/schema/chat";
import { notes, projects } from "@solyn/db/schema/workspace";
import { noteProposals } from "@solyn/db/schema/note-proposals";
import { and, asc, desc, eq, exists, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
  sourceRefs: messages.sourceRefs,
};
// Never spread private persisted references into an API/Server Action result.
const publicMessage = (
  { sourceRefs: _sourceRefs, ...message }: Message,
  sources: contracts.SourceView[] = [],
) => ({ ...message, sources });
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

  async function readProposals(tx: Transaction, ownerId: string, condition: SQL) {
    const rows = await tx
      .select({
        id: noteProposals.id,
        sourceMessageId: noteProposals.sourceMessageId,
        projectHint: noteProposals.projectHint,
        title: noteProposals.title,
        content: noteProposals.content,
        noteDate: noteProposals.noteDate,
        status: noteProposals.status,
        noteId: noteProposals.noteId,
        approvedProjectId: noteProposals.approvedProjectId,
        conversationId: messages.conversationId,
        turnId: messages.turnId,
        scopeId: conversations.projectId,
        scopeName: projects.name,
      })
      .from(noteProposals)
      .innerJoin(messages, eq(messages.id, noteProposals.sourceMessageId))
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .leftJoin(projects, eq(projects.id, conversations.projectId))
      .where(
        and(
          condition,
          owned(ownerId),
          eq(messages.role, "assistant"),
          eq(messages.status, "completed"),
        ),
      );
    const result = new Map<string, contracts.ProposalView>();
    for (const row of rows) {
      let receipt: contracts.ProposalView["receipt"] = null;
      if (row.status === "confirmed") {
        if (!row.noteId || !row.approvedProjectId) throw missing();
        const [note] = await tx
          .select({ id: notes.id })
          .from(notes)
          .innerJoin(projects, eq(projects.id, notes.projectId))
          .where(
            and(
              eq(notes.id, row.noteId),
              eq(notes.projectId, row.approvedProjectId),
              eq(projects.ownerId, ownerId),
            ),
          );
        if (!note || (row.scopeId && row.scopeId !== row.approvedProjectId)) throw missing();
        receipt = {
          noteId: row.noteId,
          projectId: row.approvedProjectId,
          href: `/projects/${row.approvedProjectId}/notes/${row.noteId}`,
        };
      }
      const view = contracts.proposalViewSchema.parse({
        id: row.id,
        sourceMessageId: row.sourceMessageId,
        conversationId: row.conversationId,
        turnId: row.turnId,
        status: row.status,
        draft: {
          projectHint: row.projectHint,
          title: row.title,
          content: row.content,
          noteDate: row.noteDate,
        },
        scopedProject: row.scopeId ? { id: row.scopeId, name: row.scopeName } : null,
        receipt,
      });
      if (result.has(view.sourceMessageId)) throw new Error("Duplicate proposal source");
      result.set(view.sourceMessageId, view);
    }
    return result;
  }
  async function proposalFor(tx: Transaction, ownerId: string, message: Message) {
    if (message.role !== "assistant" || message.status !== "completed") return null;
    return (
      (await readProposals(tx, ownerId, eq(noteProposals.sourceMessageId, message.id))).get(
        message.id,
      ) ?? null
    );
  }

  async function readSources(
    tx: Transaction,
    ownerId: string,
    projectId: string | null,
    rows: Message[],
  ) {
    const refs = new Map<string, contracts.SourceRef[]>();
    for (const row of rows) {
      const parsed = contracts.sourceRefsSchema.nullable().parse(row.sourceRefs ?? null);
      if (!parsed) continue;
      if (
        row.role !== "assistant" ||
        row.status !== "completed" ||
        (projectId !== null && parsed.some((ref) => ref.projectId !== projectId))
      )
        throw new Error("Invalid stored source scope");
      refs.set(row.id, parsed);
    }
    const ids = [...new Set([...refs.values()].flat().map((ref) => ref.noteId))];
    const found = ids.length
      ? await tx
          .select({
            id: notes.id,
            projectId: notes.projectId,
            title: notes.title,
            updatedAt: notes.updatedAt,
            projectName: projects.name,
          })
          .from(notes)
          .innerJoin(projects, eq(projects.id, notes.projectId))
          .where(
            and(
              inArray(notes.id, ids),
              projectId !== null ? eq(notes.projectId, projectId) : undefined,
              eq(projects.ownerId, ownerId),
            ),
          )
      : [];
    const available = new Map(
      found
        .filter((note) => projectId === null || note.projectId === projectId)
        .map((note) => [note.id, note]),
    );
    return new Map(
      [...refs].map(([messageId, sources]) => [
        messageId,
        contracts.sourcesSchema.parse(
          sources.map((ref, index) => {
            const note = available.get(ref.noteId);
            return note && note.projectId === ref.projectId
              ? {
                  ordinal: index + 1,
                  state: "available",
                  noteId: note.id,
                  projectId: note.projectId,
                  projectName: note.projectName,
                  title: note.title,
                  href: `/projects/${note.projectId}/notes/${note.id}`,
                  retrievedUpdatedAt: ref.retrievedUpdatedAt,
                  updatedAt: note.updatedAt.toISOString(),
                }
              : { ordinal: index + 1, state: "unavailable" };
          }),
        ),
      ]),
    );
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
    sourceRefs: contracts.SourceRef[] | null = null,
  ) {
    const [row] = await tx
      .update(messages)
      .set({ status, content, sourceRefs, updatedAt: now })
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
          const sourceRefs = "sourceRefs" in value ? value.sourceRefs : null;
          if (response.status !== "pending") {
            const stored = contracts.sourceRefsSchema.nullable().parse(response.sourceRefs ?? null);
            if (
              response.status !== status ||
              response.content !== content ||
              JSON.stringify(stored) !== JSON.stringify(sourceRefs)
            )
              throw conflict();
            const sources = await readSources(tx, ownerId, conversation.projectId, [response]);
            return publicMessage(response, sources.get(response.id)); // No history/timestamp rewrite.
          }
          const now = await databaseNow(tx);
          if (status === "completed" && abandoned(response, now)) throw conflict();
          if (
            conversation.projectId !== null &&
            sourceRefs?.some((ref) => ref.projectId !== conversation.projectId)
          )
            throw new ChatError("INVALID_INPUT", "Invalid response source scope.");
          const sources = await readSources(tx, ownerId, conversation.projectId, [
            { ...response, status, sourceRefs },
          ]);
          const projected = sources.get(response.id) ?? [];
          if (projected.some((source) => source.state === "unavailable")) throw missing();
          const updatedAt = activityTime(now, conversation.updatedAt);
          const result = await setTerminal(
            tx,
            ownerId,
            response,
            status,
            content,
            updatedAt,
            sourceRefs,
          );
          await touch(tx, ownerId, conversation.id, updatedAt);
          return publicMessage(result, projected);
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
          .where(
            and(
              owned(ownerId),
              value.projectId === null
                ? isNull(conversations.projectId)
                : value.projectId
                  ? eq(conversations.projectId, value.projectId)
                  : undefined,
            ),
          )
          .orderBy(desc(conversations.updatedAt), desc(conversations.id))
          .limit(value.limit)
          .offset(value.offset),
      );
    },
    getNoteProposal(input: unknown) {
      return run(contracts.getProposalInput, input, (value, ownerId) =>
        db.transaction(
          async (tx) => {
            const found = await readProposals(tx, ownerId, eq(noteProposals.id, value.proposalId));
            const proposal = [...found.values()][0];
            if (!proposal) throw missing();
            return proposal;
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        ),
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
              .orderBy(
                ...(value.latest
                  ? [desc(messages.createdAt), asc(messages.role), desc(messages.id)]
                  : [asc(messages.createdAt), desc(messages.role), asc(messages.id)]),
              )
              .limit(value.limit)
              .offset(value.offset);
            // Detect pending work even when its message lies outside the requested page.
            const [pending] = await tx
              .select(messageFields)
              .from(messages)
              .where(and(ownedMessages(ownerId, conversation.id), eq(messages.status, "pending")))
              .limit(1);
            const now = await databaseNow(tx);
            const sourceIds = page
              .filter((m) => m.role === "assistant" && m.status === "completed")
              .map((m) => m.id);
            const proposals = sourceIds.length
              ? await readProposals(tx, ownerId, inArray(noteProposals.sourceMessageId, sourceIds))
              : new Map<string, contracts.ProposalView>();
            const sources = await readSources(tx, ownerId, conversation.projectId, page);
            return {
              conversation,
              messages: (value.latest ? page.reverse() : page).map((m) => ({
                ...publicMessage(m, sources.get(m.id)),
                proposal: proposals.get(m.id) ?? null,
              })),
              pendingTurn: pending
                ? { turnId: pending.turnId, abandoned: abandoned(pending, now) }
                : null,
            };
          },
          { isolationLevel: "repeatable read", accessMode: "read only" },
        ),
      );
    },
    getGenerationContext(input: unknown) {
      return run(contracts.generationContextInput, input, async (value, ownerId) =>
        db.transaction(
          async (tx) => {
            const [conversation] = await tx
              .select(conversationFields)
              .from(conversations)
              .where(owned(ownerId, value.conversationId));
            if (!conversation) throw missing();
            let project: { name: string; description: string | null } | null = null;
            if (conversation.projectId) {
              const [row] = await tx
                .select({
                  name: sql<string>`left(${projects.name}, 200)`,
                  description: sql<string | null>`left(${projects.description}, 1000)`,
                })
                .from(projects)
                .where(and(eq(projects.id, conversation.projectId), eq(projects.ownerId, ownerId)));
              if (!row) throw missing();
              project = row;
            }
            // Only completed pairs from this owned conversation. No notes or
            // unrelated project history. Limit both row count and fetched text.
            const users = alias(messages, "context_user");
            const turns = await tx
              .select({
                user: sql<string>`left(${users.content}, 2000)`,
                assistant: sql<string>`left(${messages.content}, 2000)`,
              })
              .from(messages)
              .innerJoin(
                users,
                and(
                  eq(users.conversationId, messages.conversationId),
                  eq(users.turnId, messages.turnId),
                  eq(users.role, "user"),
                  eq(users.status, "completed"),
                ),
              )
              .where(
                and(
                  ownedMessages(ownerId, conversation.id),
                  eq(messages.role, "assistant"),
                  eq(messages.status, "completed"),
                  ne(messages.turnId, value.turnId),
                ),
              )
              .orderBy(desc(messages.createdAt), desc(messages.id))
              .limit(8);
            return { conversation, project, turns: turns.reverse() };
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
              const proposal = await proposalFor(tx, ownerId, assistant);
              const sources = await readSources(tx, ownerId, conversation.projectId, [
                user,
                assistant,
              ]);
              return {
                user: publicMessage(user),
                assistant: publicMessage(assistant, sources.get(assistant.id)),
                replayed: true,
                abandoned: abandoned(assistant, now),
                proposal,
              };
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
            return {
              user: publicMessage(user),
              assistant: publicMessage(assistant),
              replayed: false,
              abandoned: false,
              proposal: null,
            };
          },
          { isolationLevel: "read committed" },
        ),
      );
    },
    completeProposal(input: unknown) {
      return run(contracts.completeProposalInput, input, (value, ownerId) =>
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
            if (response.status !== "pending") {
              const proposal = await proposalFor(tx, ownerId, response);
              if (
                response.status !== "completed" ||
                response.content !== value.content ||
                !proposal ||
                JSON.stringify(proposal.draft) !== JSON.stringify(value.draft)
              )
                throw conflict();
              return { ...publicMessage(response), proposal };
            }
            let projectName: string | null = null;
            if (conversation.projectId) {
              const [project] = await tx
                .select({ name: projects.name })
                .from(projects)
                .where(and(eq(projects.id, conversation.projectId), eq(projects.ownerId, ownerId)))
                .for("share");
              if (!project) throw missing();
              projectName = project.name;
            }
            const [user] = await tx
              .select({ content: messages.content })
              .from(messages)
              .where(
                and(
                  ownedMessages(ownerId, conversation.id),
                  eq(messages.turnId, value.turnId),
                  eq(messages.role, "user"),
                ),
              );
            if (!user) throw missing();
            if (!contracts.proposalMatchesContext(value.draft, user.content, projectName))
              throw new ChatError(
                "INVALID_INPUT",
                "The draft does not match the supplied context.",
              );
            const now = await databaseNow(tx);
            if (abandoned(response, now)) throw conflict();
            const updatedAt = activityTime(now, conversation.updatedAt);
            const completed = await setTerminal(
              tx,
              ownerId,
              response,
              "completed",
              value.content,
              updatedAt,
            );
            const [inserted] = await tx
              .insert(noteProposals)
              .values({
                sourceMessageId: response.id,
                ...value.draft,
              })
              .returning({ id: noteProposals.id });
            if (!inserted) throw new Error("Missing proposal insert");
            await touch(tx, ownerId, conversation.id, updatedAt);
            const proposal = contracts.proposalViewSchema.parse({
              id: inserted.id,
              sourceMessageId: response.id,
              conversationId: conversation.id,
              turnId: value.turnId,
              status: "proposed",
              draft: value.draft,
              scopedProject: conversation.projectId
                ? { id: conversation.projectId, name: projectName }
                : null,
              receipt: null,
            });
            return { ...publicMessage(completed), proposal };
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
            if (response.status !== "pending") {
              const sources = await readSources(tx, ownerId, conversation.projectId, [response]);
              return publicMessage(response, sources.get(response.id));
            }
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
            return publicMessage(result);
          },
          { isolationLevel: "read committed" },
        ),
      );
    },
  };
}
