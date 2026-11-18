# Phase 2B — chat persistence (no provider or UI)

`server.ts` is the server-only entry point. It supplies the existing database and a fresh Better Auth request session to `createChatService`. The factory is an internal offline-test seam, not an API accepting caller-supplied identity. No Server Actions, routes, provider SDKs, keys, or client navigation are added. Response completion/failure callbacks are internal server operations; Phase 2C must not expose them as client-controlled assistant-content writes.

## Operations and contracts

All operations return `{ ok: true, data }` or a safe `{ ok: false, error: { code, message } }`. Session verification precedes strict Zod validation and SQL. Unknown fields (including `ownerId`, mutable scope, role/status and caller time) are rejected. Foreign/missing conversations, projects and turns share `NOT_FOUND`. Unexpected failures return `UNAVAILABLE` without logging/returning driver errors or content.

- `createConversation({ title, projectId? })`: null/omitted project means global. A project scope must be owned and is locked `FOR SHARE` during creation. Scope and owner have no update operation; there is no rename/delete operation. Titles are trimmed, 1–300 characters; a future caller may derive a title from the first message without an LLM call.
- `listConversations({ limit?, offset? })`: owned history, `updatedAt DESC, id DESC`.
- `getConversation({ conversationId, limit?, offset? })`: conversation, a bounded message page, and `pendingTurn: { turnId, abandoned } | null`, even if the pending message is outside the page. A read-only REPEATABLE READ transaction gives one coherent snapshot. Reading never repairs or changes history.
- `beginTurn({ conversationId, turnId, content, modelId? })`: atomically writes user/completed plus assistant/pending and advances conversation activity. User content is preserved exactly (nonblank, at most 100,000 characters). Model ID is optional/null or a nonblank string up to 200 characters; future provider code, not a client/model, chooses the supported ID.
- `completeResponse({ conversationId, turnId, content })`: pending to completed, with nonblank content up to 100,000 characters. Model ID comes from the persisted begin operation and is not replaced by callbacks.
- `failResponse` / `stopResponse({ conversationId, turnId, content? })`: pending to failed/stopped. Optional content can retain partial output, including empty output, but must never be a raw exception or secret. Omission preserves stored content. The user message stays completed and unchanged.
- `recoverAbandonedTurn({ conversationId, turnId })`: explicitly changes an expired pending assistant to failed, preserving its content. A nonexpired pending turn conflicts; already terminal turns are returned unchanged.

Both list/page contracts default to 50 records, maximum 100, offset 0–100,000. Offset pagination is deterministic for a fixed snapshot, not a frozen history across requests while activity changes. Message order is `createdAt ASC, role DESC, id ASC`: user precedes assistant when a pair shares its timestamp. New turns use a PostgreSQL-clock timestamp strictly newer than the locked conversation activity timestamp. Failed/stopped messages remain in history; only completed responses should become future answer context, according to Phase 2C's separately reviewed prompt policy.

## Idempotency, concurrency and interruption

Every turn mutation takes an ownership-filtered `FOR UPDATE OF chat_conversations` lock in a short READ COMMITTED transaction. Subsequent statements see the previous lock holder's commit. Message queries/updates also include an owned-conversation predicate. Project-scoped access additionally requires the project still belongs to the session owner. There is no ownership-transfer feature.

`(conversation_id, turn_id, role)` is unique. A partial unique index on conversation ID where status is pending adds database-level protection against more than one pending assistant, even if a writer violates the service protocol. A CHECK allows pending only for assistants (user messages must be completed with no model ID). Raw SQL can still violate pairing or scope immutability: all application writers must use this service; no triggers or new auth/RLS behavior are introduced.

A begin replay requires the same exact user content and normalized model ID, returns both existing records with `replayed: true`, and never restarts generation or rewrites timestamps. Changed payloads conflict; an incomplete pair fails closed. Exact terminal callback replay is a no-op; changed terminal content/status conflicts. Once failed/stopped/completed, a turn cannot be resurrected. A new attempt needs a **new turn ID** and preserves the previous pair.

**Future Phase 2C contract:** call a provider only after a confirmed successful begin with `replayed: false`, and only after the begin transaction commits. Never interpret replayed pending as permission to start another provider call. Hold no database transaction while waiting on the provider. On ambiguous begin/commit failure, inspect/replay the same turn ID rather than issuing a new one. An unknown successful commit may leave an unstarted pending record; use the interruption protocol, not an automatic duplicate generation.

The pending deadline is **10 minutes from the assistant's creation timestamp**, measured against PostgreSQL `clock_timestamp()` after acquiring the conversation lock. No client time, polling worker, heartbeat field or background job is used. This is an implementation policy for PM review, not a measured provider SLA. Phase 2C must abort/bound provider calls below it; otherwise a new turn may begin while an obsolete external request is still running, though the old response can no longer be persisted.

A replay/read reports abandonment at the inclusive deadline without writing. Explicit recovery, or beginning a different turn, marks the abandoned pending record failed under the same conversation lock. Begin retires the old response and inserts the new pair atomically, so a failed insert cannot consume the recovery. Completion after the deadline conflicts; a late callback cannot overwrite a recovered/stopped response. Failed/stopped records are distinguishable from an outstanding pending record; there is no additional `interrupted` database status.

Conversation activity, response finalization, and any recovery/new pair commit together. No-op replays do not move history to the top. All writers use server-selected times; `$onUpdate` remains a Drizzle hook rather than a database trigger.

## Verification boundary

`chat.test.ts` uses the real Drizzle SQL builder over scripted drivers, plus a deterministic in-memory transaction/lock simulator for simultaneous begins. It tests owner predicates, ordering, validation, transaction routing, replay, contention decisions, deadlines, and rollback/error paths **offline**. It does not prove actual PostgreSQL locks, constraints, MVCC snapshots, persistence, network failures, or rollback/concurrency behavior. `packages/db/src/chat-schema.test.ts` checks metadata, relational query compilation, and generated migration structure without connecting.

Before database execution, review the migration and the `public` schema Data API exposure/grants/RLS gate in `packages/db/src/migrations/README.md`. Better Auth sessions are not Supabase Auth JWTs; do not use `auth.uid()` as Solyn's owner ID.
