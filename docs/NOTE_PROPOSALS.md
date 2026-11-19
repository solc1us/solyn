# P3.1 — Durable note proposals: schema and application contract

**Status: prepared offline for PM review; migration NOT APPLIED.** Only schema, relations, generated migration artifacts and offline tests are implemented. Everything below describing operations, DTOs, tool calls, SSE or UI is a **future implementation contract**, not available runtime behavior. No authentication/permission change is approved by this document.

Product basis: `PRD.md` UJ-02, FR-06/07/08/14. Current code wins over the historical Phase 1 design. Retain Next.js/Bun, Better Auth, Drizzle/PostgreSQL, existing Groq/AI SDK, workspace services and custom SSE. T1 TLS is complete and unchanged.

## 1. Inspected implementation and compatibility

- `apps/web/src/features/chat/{contracts,service,stream-handler,transport,client-state,actions}.ts`, Chat README and existing tests: owner/scope checks, unique turn-role pairs, conversation-row locking, terminal replay, ten-minute abandoned-pending recovery, bounded custom SSE and mounted view-local state.
- `apps/web/src/features/workspace/{contracts,service,server,actions}.ts`: fresh sessions, strict Zod, preserved original content, calendar dates, owned project `FOR SHARE`, transactional note creation, outgoing revisions on later edits.
- `packages/db/src/{schema,relations.ts,migrations}`: existing Phase 1 baseline and Phase 2 incremental migration; no history rewrite.
- Installed `ai@7.0.176`, `@ai-sdk/groq@4.0.85`, Drizzle ORM/Kit `1.0.0-rc.5`. SDK bundled Tool Calling docs define `inputSchema` and optional `execute`; `stream-text.ts` defaults to one step (`isStepCount(1)`). Groq's `groq-prepare-tools.ts` maps function schemas/strict/tool choice, and its options support `parallelToolCalls`. These are offline API observations, not a live provider capability guarantee for every schema.
- Current stream accepts only nonempty text ending with `stop`; it rejects `tool-calls`. Current transport ignores unknown events and requires text before finish. History has no proposal DTO. Those paths need coordinated later changes; adding a tool alone cannot enable this feature.

## 2. One table, no duplicated owner or source scope

Schema: `packages/db/src/schema/note-proposals.ts`.

| SQL column            | Type/default                      | Meaning                                                     |
| --------------------- | --------------------------------- | ----------------------------------------------------------- |
| `id`                  | UUID PK, `gen_random_uuid()`      | Server/DB-generated proposal and idempotency identity       |
| `source_message_id`   | UUID NOT NULL, UNIQUE, FK         | Source assistant message; one accepted proposal per source  |
| `project_hint`        | nullable text                     | Original validated model hint, never an authorization claim |
| `title`               | text NOT NULL                     | Original validated title, trimmed by application validation |
| `content`             | text NOT NULL                     | Original validated content, preserved verbatim              |
| `note_date`           | nullable date, no default         | Original historical date, possibly unknown                  |
| `status`              | text NOT NULL, default `proposed` | Only `proposed` / `confirmed` allowed by receipt CHECK      |
| `note_id`             | nullable UUID FK                  | Confirmed result; null until confirmation                   |
| `approved_project_id` | nullable UUID FK                  | Final user-selected, authorized project                     |
| `approved_title`      | nullable text                     | Immutable canonical approved title                          |
| `approved_content`    | nullable text                     | Immutable approved content, including exact whitespace      |
| `approved_note_date`  | nullable date, no default         | Immutable approved date; null is valid even when confirmed  |
| `created_at`          | timestamptz NOT NULL, `now()`     | Proposal persistence time, not event date                   |
| `confirmed_at`        | nullable timestamptz, no default  | Server/DB-selected confirmation time                        |

Relationships and mapping:

```text
proposal.source_message_id -> chat_messages.id [must be assistant/completed]
                          -> (conversation_id, turn_id)
                          -> chat_conversations.owner_id [Better Auth user.id]
                          -> chat_conversations.project_id [nullable original scope]
proposal.note_id           -> notes.id
proposal.approved_project_id -> projects.id
```

There is no `owner_id`, `conversation_id`, `turn_id`, duplicated original project ID, draft revision, `updated_at`, expiry or confirmation-request key. The source already supplies owner/turn/scope; its conversation ownership/scope and terminal messages are immutable under existing application operations. **Future ownership transfers, source deletion or history mutation require a new review**, not an assumption that derived ownership remains safe.

Project-scoped drafts derive their target from the conversation. General-chat drafts remain unresolved: an explicit owned project selection stays local until confirmation and is then stored in `approved_project_id`. A project name hint is not a selected project.

Constraints/indexes:

- PK on `id` and UNIQUE on `source_message_id` supply the only two indexes. Planned reads use proposal PK or bounded message IDs from a history page; no separate owner/project/date/status index is justified. FK deletes can scan referencing rows; there is no delete API in scope.
- Existing UNIQUE `(conversation_id, turn_id, role)` means there is one assistant source per turn. Combined with source UNIQUE **and service enforcement of assistant role**, one turn has at most one accepted proposal. Source FK alone does not exclude user/pending messages; this is explicitly an application check, not a false database-only guarantee.
- All three FKs use `ON DELETE RESTRICT`, `ON UPDATE NO ACTION`. Retained sources, resulting notes and approved projects cannot be deleted through these references. No cascades or destructive operations are added.
- Draft title/content and any non-null approved title/content must be nonblank.
- Receipt CHECK: `proposed` requires every receipt field, including approved date and confirmed time, to be NULL. `confirmed` requires note/project/title/content/time; approved date may remain NULL. Other statuses are rejected. SQL NOT NULL/IS NULL checks avoid a partially populated receipt slipping through CHECK's NULL semantics.
- Size/calendar/Unicode validation, ownership, assistant/completed source, scope consistency, cross-table note/project correspondence, immutability, exact replay and atomic creation remain **service invariants**. No trigger or new authorization policy is introduced. Raw database writers can violate them and must not be exposed to clients/models.

## 3. Minimal lifecycle and retention

```text
proposed --explicit authenticated confirmation + atomic note creation--> confirmed
```

- Original source/hint/title/content/date never change. Confirmation fills the separate receipt once; an exact replay changes nothing, including timestamps.
- User edits and project selection stay local. Reload recovers the original persisted draft, not unsaved edits; warn before leaving/discarding edits. No autosave or browser storage is proposed.
- Dismiss/cancel means stop reviewing locally, not a server mutation. Reload may show the original proposal again. No `cancelled` status/action is justified for this slice; permanent cancellation would need separate approval. Stop during generation is different: it uses existing chat cancellation.
- Regeneration requires an explicit **new chat turn**, hence a new source/proposal. Existing turn replays never regenerate. Separate new proposals can intentionally create separate notes; no semantic/content-based deduplication is promised.
- Retain proposed drafts and confirmed receipts with their source history indefinitely for this MVP. No expiry, worker, cleanup, revision engine or delete endpoint. This is a minimum no-cleanup policy, not a final privacy/deletion policy; revisit before adding account/chat/project deletion.

## 4. No-write `prepareNote` tool

Proposed strict, complete arguments (all four keys required; no extra keys):

```ts
{
  projectHint: string | null;
  title: string;
  content: string;
  noteDate: string | null;
}
```

- Use SDK `tool({ inputSchema })` **without `execute`**. The tool has no DB/service/session capability. Only server orchestration may persist a validated proposal after inference; this stores a draft, never project knowledge. No note-save tool is supplied to the model.
- Reuse the existing note title/content/calendar validation: title trimmed 1–300 JS units, content nonblank and verbatim up to 100,000, real `YYYY-MM-DD` in years 0001–9999 or null. Hint is trimmed, nonblank when supplied, max 200 (same project-name bound). Apply existing `isChatText` Unicode/NUL safety to every textual argument and final confirmation text, without changing manual note CRUD.
- Provider work keeps current 4,000-unit input, bounded completed-pair context, 1,024 output tokens, 20,000-unit total visible text + serialized tool-argument budget, 120-second deadline, low reasoning effort and `maxRetries: 0`. A complete draft can be shorter than the workspace's 100,000-unit maximum. Do not increase those limits silently; output exhaustion fails even if a JSON prefix looks valid.
- Ordinary text: zero tool calls, nonempty text, finish `stop`. Proposal: exactly one valid call named `prepareNote`, finish `tool-calls`, no invalid/unknown/second call. Reject conflicting, invalid, truncated or multiple calls as a failed turn. Do not salvage a first call, repair arguments through another inference, or expose partial arguments. Keep one inference step; disable parallel tool calls as a provider hint, but enforce cardinality server-side too.
- Reasoning, model-supplied status/owner/IDs/confirmation and raw provider errors are never client-visible authority. Prior chat text/metadata/hints remain untrusted data. No retrieval, notes access, free-form SQL, loop or automatic retry is added.
- Dates default to null when not explicitly supplied by the user. A syntactically valid invented date is still invalid behavior: validate against explicit user date information or leave null; ambiguous relative dates need clarification/user correction. Never infer historical dates from insertion time or silently use today.

### Project resolution

- Project chat: freshly read the owned conversation and project. Target is that project, not a supplied model ID. A non-null hint inconsistent with this scope fails safely/asks clarification; it never changes the scope. An equal name does not identify a different same-named project.
- General chat: always require explicit selection from the authenticated project's list, even if a hint looks like an exact match. Do not treat the first matching paginated name as uniquely resolved. Empty/unknown/ambiguous hints may still yield an unresolved validated draft with a clear project-required state, never an enabled save with a guessed target.
- Foreign and nonexistent project IDs both return NOT_FOUND. No lookup outside the owned set, cross-owner candidate count or automatic project creation. Project choices/read labels are server-resolved, not model-controlled.

## 5. Atomic assistant finalization and custom SSE extension

Keep `/api/chat/stream`, its strict existing request, same-origin/session boundary, SSE parser, begin/replay identity and pending deadline. No parallel transport or generic event system.

1. Confirm existing `beginTurn` commit before exactly one provider request; replay never calls the provider. No transaction spans provider work.
2. Accumulate bounded tool arguments privately. Validate full arguments, finish reason, cardinality, source scope and safety before attempting persistence.
3. Add a future **internal** proposal-completion branch beside `completeResponse`: fresh session; owned conversation `FOR UPDATE`; check pending assistant and existing ten-minute deadline; validate/resolve again; insert proposal referencing that assistant; mark assistant completed and touch activity **in one READ COMMITTED transaction**. Roll back all three on any error. No client-callable assistant/proposal insertion action.
4. Tool-only completion uses deterministic nonempty assistant text: `Draft ready for review. No note has been saved.` Emit that as an ordinary text delta, then save it with the proposal atomically. Mixed text/tool responses retain safe visible text under existing limits; the proposal card, not model prose, supplies trusted saved-note state. Do not persist tool JSON as assistant text or require a second model call.
5. Only after confirmed commit, extend existing `finish` with `proposal: ProposalView | null`. No new event is needed. Text-only finishes set null. Existing `persisted: true` still means chat finalization, **never note creation**. If finalization is unconfirmed, emit existing safe persistence failure, not a proposal identity/capability.

Proposed DTO (only validated server reads/finalization responses may populate it):

```ts
type ProposalView = {
  id: string;
  sourceMessageId: string;
  conversationId: string; // derived
  turnId: string; // derived
  status: "proposed" | "confirmed";
  draft: { projectHint: string | null; title: string; content: string; noteDate: string | null };
  scopedProject: { id: string; name: string } | null; // authorized source scope
  receipt: { noteId: string; projectId: string; href: string } | null;
};
```

- Extend terminal JSON replay with the same `proposal` field (null for pending/failed/stopped/text-only); read it after acquiring the existing conversation lock, not from a stale pre-lock snapshot. A terminal proposal callback replay compares original source/draft, returns the existing proposal without insertion/timestamp changes, and never regresses an already-confirmed receipt.
- Extend each history message DTO with `proposal: ProposalView | null`, fetched for that bounded page in the existing read-only REPEATABLE READ snapshot. Only assistant/completed rows can carry one; foreign/inconsistent relations fail closed. Do not load every proposal or leak approved content into unrelated history. No raw owner IDs or provider tool-call IDs are needed in DTOs.
- Client validates identities against conversation, turn and assistant message ID; rejects duplicate/mismatched proposal receipts. No confirmation is enabled from text deltas/tool fragments. Current tool-only length requirement is satisfied by deterministic text. New DTO/event parsing must ship with server changes, not be silently ignored by old clients. A confirmed local receipt must not be downgraded by a route read started earlier; reconcile with a fresh read, as existing chat does for terminal state.
- Add a small future authenticated `getNoteProposal({ proposalId })` read for exact recovery outside a visible history page. Same source/owner/scope checks and safe result union; it performs no repairs. A confirmed receipt is returned only while source and resulting project/note remain authorized.

### Stop, failures and process termination

- Before/during inference: existing Stop/disconnect aborts inference; finalize stopped/failed safe text with **no proposal**. Completed arguments alone do not authorize a draft. Session expiry denies finalization rather than bypassing authorization.
- If cancellation is observed before the atomic finalization attempt, stop without a proposal. Once finalization has started, never race it with a second stopped/failed write. Its commit can win despite a late Stop; reload reports the persisted proposal, still not a saved note. Stop never retracts a committed proposal.
- Crash after begin but before finalization: pending assistant, no durable tool fragments/proposal. Existing explicit/new-turn ten-minute recovery applies; reads/replays never repair or infer again.
- Crash during the transaction: either full rollback or completed assistant + proposal + activity together. A lost commit acknowledgement is **unconfirmed**, not proof of rollback. Reload/same-turn replay recovers whichever committed; never insert a proposal in a separate follow-up transaction.
- Crash after commit/before SSE delivery: history/replay returns the original proposal ID. Do not regenerate or create a new ID to recover. Failure to read keeps confirmation blocked until an authorized read succeeds.

## 6. Explicit confirmation action and transaction

Proposed strict input (no owner/status/time/assistant content/approved flag/revision key):

```ts
{
  proposalId: string; // UUID
  projectId: string; // UUID, final user selection
  title: string;
  content: string;
  noteDate: string | null; // required key; null means unknown/cleared
}
```

Call only from a dedicated explicit user action on the specific editable preview. Use a Next.js Server Action and the existing safe result union, CSRF/origin protection and server-only composition patterns. Do not expose it as a model tool or call it merely because chat text says "yes". Public actions cannot prove a physical click; the authenticated explicit action request, not a model boolean, is the approval boundary.

**Recommend A:** extract the small transaction-compatible owned-project-lock + note-insert core inside the existing workspace service, and use it from manual `createNote` and a dedicated `confirmNoteProposal` operation in that service. Reuse its fresh-session `run`, existing create-note schema and typed Drizzle transaction; no generic repository, exported raw insert primitive or transaction framework. Manual CRUD input/output, revision behavior and own transaction remain unchanged. B with a wholly separate insert would duplicate the same ownership-sensitive logic; calling current `workspace.createNote` inside an outer transaction would independently commit its inner DB transaction and is **not atomic**. This extraction is recommended only; no service code changes in P3.1.

Future operation sequence:

1. Fresh session before SQL, strict input validation; canonicalize UUIDs/lowercase and trimmed title using existing contracts. Preserve content byte-for-byte as represented by the JS string; date is exact ISO or null. Reject unknown keys and unsafe Unicode/NUL. Do not generate a new key per click.
2. Begin READ COMMITTED. Discover the owned source from proposal ID, then lock its owned conversation `FOR SHARE`. Acquire proposal `FOR UPDATE` in a separate statement, rejoining/rechecking owned source. Re-read after any wait. Consistent lock order: conversation -> proposal -> project. Chat finalization/recovery already starts with conversation locking; keep that order. No external/provider work inside the transaction.
3. Require source assistant/completed, owned conversation and (if scoped) still-owned source project. Missing/foreign source/proposal => same NOT_FOUND. Client project must equal source project in project chat; otherwise conflict, never reassignment. General chat permits any presently owned selected project. Share-lock/recheck the selected owned project, as manual note creation already does.
4. If already confirmed: compare the **canonical submitted** `{ projectId, title, content, noteDate }` against the four stored approved fields, not original draft or mutable current note. Exact replay returns original note ID after verifying its current project/ownership; different payload => CONFLICT. Do not insert/update anything or change timestamps. Invalid input still fails validation before replay.
5. If proposed: use the shared note-creation core under this same transaction; insert exactly one current note with logical version 1 and no revision snapshot. Set status confirmed, returned note ID, all canonical approved fields and database confirmation time on the locked proposal. Source and original draft stay unchanged. Throw inside the transaction on any missing result or unexpected update count; roll back both writes.
6. Commit before returning `{ proposalId, noteId, projectId, href, replayed }` in the existing success union. `href` is `/projects/{projectId}/notes/{noteId}` from authorized returned IDs, never model text. Revalidate the existing project/dashboard/note views only after confirmed success; no need to reorder chat history on note confirmation.

The proposal ID plus immutable receipt is the idempotency key. No expected-version field is needed: server draft edits do not exist and there is only one terminal transition. Row locking serializes two clicks/tabs/processes. Different proposals are different operations. Later note edits use normal existing revision semantics; they never alter the approved receipt or make replay create another note.

On unavailable/timeout/lost acknowledgement: retain proposal ID and exact submitted payload, mark **save unconfirmed**, block new confirmation payloads, and read that proposal. Confirmed read supplies original note/link; proposed read is not a license to generate a new ID, and another in-flight confirmation could still commit. An explicit same-ID/same-payload retry is safe because it waits for the row lock then replays/conflicts; no automatic retry or blind manual `createNote` fallback. If read also fails, remain blocked. After full reload, server receipt is authoritative; unsaved edits may be lost. If only proposed is found, show original draft and require explicit new review/confirmation, never auto-submit it.

## 7. Migration, security and approval gates

Generated via unchanged existing workflow:

```sh
bun run db:generate --name note_proposals
```

Artifacts: `packages/db/src/migrations/20261119144819_note_proposals/{migration.sql,snapshot.json}`. Exactly one new table, three CHECKs, one source UNIQUE plus PK, three RESTRICT FKs and no standalone indexes. v9 diff snapshot extends `20261118093854_chat_persistence` (`c6c29e50-bb14-47cd-abeb-41b9e58cb897`). All deltas are creates belonging to `public.note_proposals`; existing auth/project/note/chat tables and both previous migrations are unchanged. No SQL execution, grants, RLS, triggers, enum, seed or data rewrite.

**Data API gate:** table is in existing `public`, with RLS not enabled by this migration. A platform default grant/exposure can bypass every application invariant, leak drafts and approved payloads, or allow forged receipts/relationships. Prior PM confirmation that Data API was disabled is historical evidence, not a fresh target privilege inspection. Before application, verify current Data API/exposed schemas, default and inherited PUBLIC/anon/authenticated privileges, GraphQL/functions/Realtime as applicable, and effective backend role/ownership/bypass-RLS/required access. No database or Management API inspection is performed in P3.1.

Recommended boundary for separate approval: keep these backend-only tables unreachable through Data API. If it remains disabled, verify the actual setting and alternate exposure paths. If enabled, review narrowly scoped revocation plus RLS/no public allow policies and the real backend-role access requirements, applied safely with creation. Do not fabricate `auth.uid()` ownership: Better Auth users/session text IDs are **not Supabase Auth JWT identities**. Do not add speculative grants or silently change policies/roles/schema.

Sources reviewed: [Supabase security guide](https://supabase.com/docs/guides/api/securing-your-api) and [changelog](https://supabase.com/changelog.md), including changing new-table auto-exposure defaults. Project-specific settings remain unverified.

PM must approve before proceeding:

1. This exact schema/SQL, derived ownership/source mapping, unresolved-general-target policy, immutable receipt and no-cleanup retention.
2. Future runtime changes: no-write tool validation, atomic chat/proposal completion, coordinated finish/history/replay DTO extension, explicit confirmation/shared-core extraction and recovery UI. P3.1 does not authorize implementing them.
3. Exact non-production migration target, real prior baseline/applied-history compatibility, exposure/backend-role protection, backup/recovery and exact migration application. Do not blindly reapply Phase 1's full auth baseline.
4. A disposable PostgreSQL target/setup/fixtures/cleanup before testing constraints, concurrent confirmations, lock scheduling, rollback, ambiguous commit and two-user persisted isolation. Live Groq test text/cost needs separate approval.

Offline tests check metadata, source uniqueness prerequisites, receipt SQL structure, relations/ownership-query compilation, migration allowlist and snapshot consistency. They **do not prove** future service authorization/immutability, actual CHECK/FK enforcement, concurrency, rollback, process termination, provider tool support or browser acceptance. Those checks cannot be completed merely by generating a migration, and are not permission to apply it.

## 8. P3.1 verification evidence

- `bun test`: **185 passed, 0 failed**, 11 files (seven new proposal schema/migration tests).
- `bun run check-types`: all four workspaces passed; `bunx oxlint`: exit 0.
- `bun run --filter web build`: exit 0; Next.js 16.4.6 compiled, typechecked and generated its existing routes.
- Changed-file `bunx oxfmt --check`: passed for seven supported TS/JSON/Markdown files; generated SQL is reviewed separately. `git diff --check`: passed (LF/CRLF configuration warnings only).
- Installed Kit `check --config drizzle.config.ts`: `Everything's fine`. A subsequent `generate --config drizzle.config.ts --explain --output json` returned `{"status":"no_changes","dialect":"postgresql"}`, verifying the local snapshot/schema chain without creating another migration.
- Existing application/service/provider/auth/TLS/dependency files and both earlier migration directories have no diff. The pre-existing `.gitignore` change remains untouched. No database connection, migration application, live provider call, commit, push or deployment was performed in this stage.
