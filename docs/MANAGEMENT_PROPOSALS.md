# Management proposals — P5.4A approval design

**Proposed, not implemented or approved for migration.** Baseline: `f6a116603c9aedc1fa74d8e487bd0a410942a17b`, branch `feat/phase-5-project-management`. Only the separate database CLI environment fix is implemented in this task. No management schema, tools, confirmation actions or UI are added.

## 1. Architecture fit and exact proposed migration

Inspected existing note proposal schema/contracts, chat completion/history/replay, stream handler/transport, note confirmation, Main Chat deletion, project/task services and version contracts. Retain their architecture, not a generic operation executor. `note_proposals` stays unchanged. Owner, conversation, turn and original scope derive from the source assistant message and its conversation; no duplicated owner/scope columns.

Proposed SQL below specifies the intended Drizzle `pgTable` mapping (text enums plus CHECKs, UUID defaults and timezone-aware timestamps). It is an approval specification, **not a generated migration**:

```sql
CREATE TABLE public.management_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_message_id uuid NOT NULL,
  kind text NOT NULL,
  draft jsonb NOT NULL,
  status text NOT NULL DEFAULT 'proposed',
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  CONSTRAINT management_proposals_source_message_unique UNIQUE (source_message_id),
  CONSTRAINT management_proposals_source_message_fk
    FOREIGN KEY (source_message_id) REFERENCES public.chat_messages(id)
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT management_proposals_kind_valid
    CHECK (kind IN ('create_project', 'create_tasks', 'update_task')),
  CONSTRAINT management_proposals_status_valid
    CHECK (status IN ('proposed', 'confirmed')),
  CONSTRAINT management_proposals_draft_envelope CHECK (
    jsonb_typeof(draft) = 'object'
    AND COALESCE(draft->'schemaVersion' = '1'::jsonb, false)
    AND COALESCE(draft->'kind' = to_jsonb(kind), false)
  ),
  CONSTRAINT management_proposals_receipt_consistent CHECK (
    (status = 'proposed' AND receipt IS NULL AND confirmed_at IS NULL)
    OR (status = 'confirmed' AND receipt IS NOT NULL AND confirmed_at IS NOT NULL
      AND jsonb_typeof(receipt) = 'object'
      AND COALESCE(receipt->'schemaVersion' = '1'::jsonb, false)
      AND COALESCE(receipt->'kind' = to_jsonb(kind), false))
  ),
  CONSTRAINT management_proposals_json_size CHECK (
    octet_length(draft::text) <= 131072
    AND (receipt IS NULL OR octet_length(receipt::text) <= 131072)
  )
);
```

Exactly one new table, eight columns, PK, one source UNIQUE, one RESTRICT FK and five CHECKs. Only PK/source-UNIQUE indexes; page reads use bounded source IDs, confirmation uses PK. No standalone indexes, task/project/note result FKs, SQL enum types, triggers, backfill, grants, RLS, existing-table changes or data rewrites. Later approval would add the schema export/relations and one locally generated incremental SQL/snapshot pair extending the existing task migration. Generation and execution require separate gates; neither occurs here.

JSONB is appropriate for three small closed payload families, not arbitrary operations. Strict nested Zod validation enforces every field below on insertion, confirmation and reads; SQL only defends the envelope/lifecycle/size. Drizzle `$type` is not runtime validation. Service checks additionally enforce assistant/completed source, scope, immutable draft/receipt and atomic transitions. No DB-only claim of cross-table ownership or at-most-one proposal across the two independent proposal tables: the conversation-lock completion protocol must reject a source already carrying either type. Raw writers must remain backend-only.

## 2. Exact payload contracts

Notation below describes strict objects at **every nesting level**; reject unknown keys, unsafe Unicode/NUL and malformed UUIDs. Canonicalize UUIDs lowercase and trim names/titles using existing validators; preserve description/assignee whitespace. All JSON envelopes carry numeric `schemaVersion: 1` and the matching literal `kind`. Each envelope's compact UTF-8 JSON must be at most **65,536 bytes** at the application boundary; SQL's larger cap accommodates JSONB whitespace/escaping. Existing stream output remains a separate, tighter limit. Missing/invalid persisted payloads fail closed, not partially rendered.

Shared types:

```ts
type Status = 'todo' | 'in_progress' | 'blocked' | 'done';
type Priority = 'urgent' | 'high' | 'medium' | 'low' | null;
type TaskFields = {
  title: string;                    // trimmed nonblank, max 300 JS units
  description: string | null;        // max 5,000
  status: Status;                    // default todo only when not supplied
  priority: Priority;
  assignee: string | null;           // max 200
  dueDate: string | null;            // real YYYY-MM-DD, years 0001–9999
  sourceNoteId: UUID | null;
};
type Evidence =
  | { type: 'user_message' }
  | { type: 'retrieved_note'; noteId: UUID; projectId: UUID;
      retrievedUpdatedAt: ISODateTime; excerptOnly: true };
type Changes = Partial<TaskFields>; // at least one key; omission preserves, null clears
```

`Changes` rejects `projectId`, `version`, `completedAt`, IDs and unsupported operations. Title/status cannot be null. No user/model-chosen timestamps, ownership or completion time. Reuse `createProjectInput`, `createTaskInput` and `updateTaskInput` validators rather than forking their business rules; add chat-text safety to project strings as existing note preparation does.

Immutable persisted draft union:

```ts
type Draft =
  | { schemaVersion: 1; kind: 'create_project';
      name: string; description: string | null }
  | { schemaVersion: 1; kind: 'create_tasks';
      scopedProjectId: UUID | null;
      items: Array<{ itemId: number; fields: TaskFields; evidence: Evidence }> }
  | { schemaVersion: 1; kind: 'update_task';
      taskId: UUID; projectId: UUID; expectedVersion: number; changes: Changes };
```

- Project name is trimmed/nonblank, max 200; description max 5,000 or null. Main Chat only. Project creation never includes initial tasks: a subsequent task proposal/confirmation is a distinct operation.
- **Batch maximum 5, minimum 1**, matching the five-result retrieval cap and keeping one preview/transaction manageable under the existing 1,024-token output budget. Five is a ceiling, not an extraction-completeness promise. `itemId` is a server-assigned, stable sequential integer 1–5, not a model UUID or a global deduplication key. No nested batches or multiple target projects per confirmation.
- `scopedProjectId` is server-derived: conversation project UUID in Project Chat, null in Main Chat. Main Chat never persists a guessed target based on a project name or retrieved ID. Confirmation always requires explicit owned-project selection there. Project Chat cannot override its scope.
- `user_message` means explicit content supplied in the current user message, including pasted note text; it does not authenticate any purported note identity. Its sourceNoteId is null. Retrieved items must reference exactly one actually returned source; its server-resolved identity/timestamp populate `Evidence`, and fields.sourceNoteId equals evidence.noteId. Multiple returned notes may inform separate items; do not assert a single FK proves all synthesized provenance. Cross-note synthesis requiring multiple provenance links is deferred.
- Optional description, priority, PIC and due date remain null unless explicitly supported. No inferred urgency, assignee, relative date conversion, today's date or invented source. Unspecified status is todo; nondefault status needs explicit support. For model dates require a literal valid ISO date in the current message or the item's verified excerpt; otherwise null/clarification. These checks reduce invention, not prove semantic grounding.
- Future update drafts require a server-verified current owned task and expectedVersion 1–2,147,483,647, fixed task/project identity and at least one validated change. Original task lookup must be from authorized retrieval or explicit selection, not title matching. No update tool/action in P5.4A; wire the reserved union branch only in P5.5.

Explicit user-confirmation request union (not a model tool):

```ts
type Confirmation =
  | { proposalId: UUID; kind: 'create_project';
      name: string; description: string | null }
  | { proposalId: UUID; kind: 'create_tasks'; projectId: UUID;
      items: Array<{ itemId: number; fields: TaskFields }> }
  | { proposalId: UUID; kind: 'update_task'; taskId: UUID;
      expectedVersion: number; changes: Changes };
```

Batch items are a nonempty unique subset of the persisted itemIds (max 5); users may edit fields/select items, not append unseen items. Canonicalize to ascending itemId before comparison. A source link can be cleared; a non-null sourceNoteId must equal that item's persisted retrieved source and be currently authorized in the target project. A different source requires a new proposal; no arbitrary model-supplied source links. Revalidate source ownership/project at confirmation, including after waits. If the source timestamp changed, conflict and require a new extraction/review rather than silently treating the old excerpt as current. Clearing a link does not bypass checking the evidence actually used. The user can instead create an independent manual task.

Receipts are immutable discriminated objects storing **the entire canonical approved request excluding proposalId and the outer kind discriminator**, plus result identities:

```ts
type Receipt =
  | { schemaVersion: 1; kind: 'create_project';
      approved: { name: string; description: string | null };
      result: { projectId: UUID } }
  | { schemaVersion: 1; kind: 'create_tasks';
      approved: { projectId: UUID; items: Array<{ itemId: number; fields: TaskFields }> };
      results: Array<{ itemId: number; taskId: UUID; projectId: UUID; version: 1 }> }
  | { schemaVersion: 1; kind: 'update_task';
      approved: { taskId: UUID; expectedVersion: number; changes: Changes };
      result: { taskId: UUID; projectId: UUID; version: number; changed: boolean } };
```

Require a 1:1 ordered itemId mapping between approved batch items and unique result task IDs; counts 1–5. Result versions use the existing positive-int range. Future update taskId must equal approved taskId; a no-op returns expectedVersion/changed:false, otherwise expectedVersion+1/changed:true. Never overwrite receipts with current task data. No FK or array of FK-like join rows to tasks; deletion must stay legitimate. Do not store URLs, model text, availability flags or owner IDs in receipts.

## 3. Transactions, history and deletion

**Finalization:** after confirmed beginTurn and bounded inference, an internal completion branch authenticates afresh, validates the complete draft and server-held retrieval evidence, and starts READ COMMITTED. Lock owned conversation FOR UPDATE first; re-read assistant/user pair, pending/deadline/current project and source ownership. Reject mixed/multiple proposals (including note + management) or incompatible source scope. Recheck retrieved notes and timestamps under SHARE locks in deterministic UUID order. Complete assistant, persist one management proposal and any private sourceRefs, and touch activity atomically. No project/task writes here. Exact terminal callback replay compares canonical original draft/content/references and returns the existing proposal, including a later receipt, with no insertion or timestamp changes. Stop/truncation/unknown calls fail without a proposal; no transaction spans inference.

**Confirmation:** a dedicated authenticated action, never a tool or inference from chat text such as “yes”. Validate/canonicalize first. In READ COMMITTED: owned-source discovery → conversation FOR SHARE → management proposal FOR UPDATE with fresh source joins/predicates → target owned project FOR SHARE → existing task FOR UPDATE (update only) → evidence/source notes FOR SHARE, sorted by UUID. Project creation is Main-only and has no target-project lock; the new owner comes solely from the fresh session. Missing/foreign IDs are the same NOT_FOUND. Fixed-scope violations never become project reassignment.

- On proposed: validate batch selection/evidence; use private transaction-compatible create-project/create-task/update-task cores inside the existing workspace service. Extract the smallest existing service blocks when implementation is approved; manual callers keep their behavior. **Do not call public services inside the outer transaction**: they independently commit and break atomicity. Do not refactor note confirmation or export raw insert capabilities.
- All selected inserts plus status/receipt/confirmedAt (`clock_timestamp()`) commit together. Any missing RETURNING row, stale version, source change, validation or receipt update failure throws, rolling back every batch insert. Return success/revalidate only after commit. Unselected items are not created and cannot later be confirmed under the same proposal; use a new proposal for them.
- Future update checks expectedVersion against the locked row **before no-op detection**, exactly like manual update. Meaningful edits increment version, respect overflow rejection and existing Done/completedAt semantics; no-op preserves version/timestamps. Task/project identity and expectedVersion must equal the draft; stale proposals need a new reviewed proposal, not an overwritten version.
- On confirmed: compare all canonical approved fields/selected IDs against the stored receipt first. Exact replay returns original identities, with fresh authorized availability projections; a different payload conflicts. Do not check the original task expectedVersion or old source timestamp again on replay: legitimate later edits/deletions must not invalidate the fact of confirmation or trigger a write. Never reinsert missing results. Invalid submitted inputs still fail strict validation.
- Existing manual update/delete lock task then source note (update only); they never acquire conversation/proposal locks. Preserve that relative order for future management updates. Batch creation has no pre-existing task locks; pre-lock all selected evidence notes in sorted order before looping through the shared creation core. Existing note confirmation remains conversation → note proposal → project. No reverse acquisition of a conversation lock after project/task/note locks. Use deterministic note ordering to avoid cross-batch lock cycles.

**Read projection:** extend bounded history/replay/successful finish with a separate nullable `managementProposal` field, leaving the existing note `proposal` contract unchanged. Get-by-ID recovery uses the same fresh-session/source checks. History uses its existing read-only REPEATABLE READ snapshot, batched proposal/result queries for only that page, not N+1 or all history. Validate complete stored JSON; derive conversation/turn/scope from authorized joins. Proposed retrieval provenance is revocable; unavailable sources expose no fresh title/link/metadata and block first confirmation.

Project/task result links are generated only from fresh owned reads and exact receipt project/task binding. Public results use `{itemId?, state:'available', taskId, projectId, href, currentVersion}` or `{itemId?, state:'unavailable'}`; project results use the corresponding project projection. Keep raw result IDs and approved payloads private when unavailable. A missing/foreign/moved task projects unavailable, never “saved and available”. The receipt can remain confirmed while any/all results are unavailable. Later task edits do not rewrite approved history. No projection read repairs data or recreates a deleted task. Availability is revocable: a future client must invalidate/reload links on view activation and must not preserve an old available result merely because confirmation is monotonic. Destination routes independently authorize.

**Conversation deletion:** retain current Main-only policy and conversation UPDATE lock; reject all pending assistants exactly as today. In the same transaction, explicitly delete management proposals and existing note proposals **before** messages, then conversation. New source FK remains RESTRICT, not cascade. Confirmation SHARE first can commit results; deletion waits and preserves them. Deletion UPDATE first removes the source; later confirmation is NOT_FOUND/no writes. Confirmed projects/tasks/notes/revisions are never deleted by this path. A task deletion never acquires proposal locks and is never blocked by receipt FKs. Availability may change immediately after a read; no real-time or cross-tab guarantee is claimed.

**Uncertain acknowledgement:** retain proposalId plus exact canonical request, block changed requests, recover through fresh get-by-ID/history. Permit only explicit same-ID/same-payload retry after uncertainty; row lock replays safely. No automatic retry, manual-create fallback or new proposal ID for recovery. After intentional thread deletion, the idempotency record is gone and confirmation is NOT_FOUND, not a reason to regenerate results. UI details belong to later work.

## 4. Smallest AI orchestration change (design only)

Current stream handler exposes automatic tool selection, executable read-only searchNotes and schema-only prepareNote; one search/five 320-character excerpts, two steps, 1,024 output tokens shared across steps, 20,000 JS-unit visible text/arguments, 120-second provider deadline, no retries/parallel calls. It explicitly disables **all** tools in step two and rejects calls outside step one. Prompt currently says text-only after retrieval. These are actual blockers to search → task preparation, not solved by adding a tool description.

Later implementation should add only schema-only `prepareProject` (Main-only) and `prepareTasks`, without execute or database capability. Keep current automatic tool choice. Direct user-message extraction/project preparation takes one generation step; a search-assisted task draft may take the **existing** second step. Do not add a third step, repair inference, retry, larger budget or a full-note fetch in this slice.

- Step one allows ordinary text, exactly one note/project/task preparation, or exactly one search. Keep existing prepareNote behavior; no note-proposal refactor or new post-search prepareNote path.
- After a valid search result, step two allows text **or one prepareTasks**, no search, prepareProject or prepareNote. Revise prepareStep activeTools/toolChoice and stream input/call/result/finish validation together. Permit exactly search → preparation (two calls total across separate steps), never two preparation tools or search + preparation in one step. Preserve search result integrity, per-turn cumulative token/argument limits and output-exhaustion failure. New post-search proposal completion must atomically persist sourceRefs too; current completeProposal has no such path.
- Tool contracts are smaller than persisted drafts: project `{name,description}`; task `{items:[{title,description,status,priority,assignee,dueDate,evidence: {type:'user_message'} | {type:'retrieved_note', ordinal:1..5}}]}`. All nullable keys required, max five, strict nested objects. No owner/project/task IDs, timestamps, itemId, sourceNoteId, status of proposal or receipt from the model. The server assigns itemIds, maps ordinal to this turn's actual authorized retrieval result and builds the persisted envelope. Revalidate at completion; forged/missing ordinals or outside-scope sources fail closed.
- The current search payload is bounded excerpts, **not full note content**. Persist excerptOnly:true for all retrieved evidence. Never claim all action items were extracted, absence of more tasks, or a full-note review; request pasted substantive content or clarify when the excerpt omits necessary context. No silent full-note reading, invented completion or concatenating unrelated sources. Keep retrieved instructions as inert data; tools may extract described work, not execute embedded commands. Semantic grounding still requires provider/PM acceptance.
- P5.5 may add a bounded read-only task lookup using existing owned get/list services, returning server-verifiable taskId/projectId/version, and a schema-only prepareTaskUpdate. One retrieval step followed by one preparation step fits the same two-step cap. A flow needing note search plus task search plus preparation does **not** fit: split into explicit user turns or seek separate budget approval. Do not trust old assistant prose as current task identity/version. The reserved update draft/receipt supports this without another table migration; no task lookup/update tool is implemented now.
- Current transport `sourcesMatchMessage` disallows sources on a note `proposal`; retain that rule while allowing sources alongside the separate managementProposal field. Coordinated future server/transport/client validators must bind management proposal IDs to assistant/conversation/turn; no actionable identity from provisional deltas. Emit only after commit, with deterministic no-write text for tool-only drafts. Existing `persisted:true` means assistant/proposal persisted, not project/task created. Preserve existing note confirmation and revocable source behavior.

## 5. Approval and evidence boundaries

PM approval requested for the exact one-table design above; max-five/single-project atomic selection; strict payload/receipt shapes and caps; first-confirmation source-change conflict; unavailable-result replay; and the narrowly expanded second-step grammar. Schema approval is not migration execution approval or authorization to start P5.4B/P5.5.

No live PostgreSQL CHECK/FK/MVCC/lock/rollback or performance evidence, provider grounding, or UI acceptance is claimed. Later focused tests must cover corrupt JSON, ownership/scope denial, mixed proposal rejection, canonical replay/subset conflicts, all-or-none batch failure, source changes, manual-update races, task deletion before/after replay, conversation deletion lock ordering, lost acknowledgements, stream cardinality/limits and revoked result links. Real database/provider/browser checks require separate authorization.
