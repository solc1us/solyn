# Management proposals — P5.4A approval design

**P5.4B: schema, persistence and confirmation backend implemented; migration NOT APPLIED.** PM approved this eight-column design, strict contracts and local artifact generation after P5.4A. Implementation baseline: `85fb5363b3454c64bb789d6ab820497f1b727217`, branch `feat/phase-5-project-management`. P5.4C's separately approved tools, stream/client integration and explicit-confirmation previews are now implemented on baseline `a1deee3ee7e56978c0ceb838db0ce3a4f532f045`; see Section 7. No migration is applied by this work. P5.5 is now separately approved and implemented on baseline `665bbef9cf22fb83df60d8cd7ffa0acc3827cf5a`; Section 8 supersedes earlier disabled-update statements. No new schema or migration is needed. The sections below retain the approved design; Section 6 records implementation boundaries.

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

Exactly one new table, eight columns, PK, one source UNIQUE, one RESTRICT FK and five CHECKs. Only PK/source-UNIQUE indexes; page reads use bounded source IDs, confirmation uses PK. No standalone indexes, task/project/note result FKs, SQL enum types, triggers, backfill, grants, RLS, existing-table changes or data rewrites. P5.4B adds the schema export/relations and the locally generated incremental `20261128060549_management_proposals/{migration.sql,snapshot.json}` pair extending the existing task migration. Generation is approved and complete; execution remains prohibited.

JSONB is appropriate for three small closed payload families, not arbitrary operations. Strict nested Zod validation enforces every field below on insertion, confirmation and reads; SQL only defends the envelope/lifecycle/size. Drizzle `$type` is not runtime validation. Service checks additionally enforce assistant/completed source, scope, immutable draft/receipt and atomic transitions. No DB-only claim of cross-table ownership or at-most-one proposal across the two independent proposal tables: the conversation-lock completion protocol must reject a source already carrying either type. Raw writers must remain backend-only.

## 2. Exact payload contracts

Notation below describes strict objects at **every nesting level**; reject unknown keys, unsafe Unicode/NUL and malformed UUIDs. Canonicalize UUIDs lowercase and trim names/titles using existing validators; preserve description/assignee whitespace. All JSON envelopes carry numeric `schemaVersion: 1` and the matching literal `kind`. Each envelope's compact UTF-8 JSON must be at most **65,536 bytes** at the application boundary; SQL's larger cap accommodates JSONB whitespace/escaping. Existing stream output remains a separate, tighter limit. Missing/invalid persisted payloads fail closed, not partially rendered.

Shared types:

```ts
type Status = "todo" | "in_progress" | "blocked" | "done";
type Priority = "urgent" | "high" | "medium" | "low" | null;
type TaskFields = {
  title: string; // trimmed nonblank, max 300 JS units
  description: string | null; // max 5,000
  status: Status; // default todo only when not supplied
  priority: Priority;
  assignee: string | null; // max 200
  dueDate: string | null; // real YYYY-MM-DD, years 0001–9999
  sourceNoteId: UUID | null;
};
type Evidence =
  | { type: "user_message" }
  | {
      type: "retrieved_note";
      noteId: UUID;
      projectId: UUID;
      retrievedUpdatedAt: ISODateTime;
      excerptOnly: true;
    };
type Changes = Partial<Omit<TaskFields, "sourceNoteId">>; // P5.5: six supported fields; at least one key; omission preserves, null clears
```

`Changes` rejects `projectId`, `version`, `completedAt`, IDs and unsupported operations. Title/status cannot be null. No user/model-chosen timestamps, ownership or completion time. Reuse `createProjectInput`, `createTaskInput` and `updateTaskInput` validators rather than forking their business rules; add chat-text safety to project strings as existing note preparation does.

Immutable persisted draft union:

```ts
type Draft =
  | { schemaVersion: 1; kind: "create_project"; name: string; description: string | null }
  | {
      schemaVersion: 1;
      kind: "create_tasks";
      scopedProjectId: UUID | null;
      items: Array<{ itemId: number; fields: TaskFields; evidence: Evidence }>;
    }
  | {
      schemaVersion: 1;
      kind: "update_task";
      taskId: UUID;
      projectId: UUID;
      expectedVersion: number;
      changes: Changes;
    };
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
  | { proposalId: UUID; kind: "create_project"; name: string; description: string | null }
  | {
      proposalId: UUID;
      kind: "create_tasks";
      projectId: UUID;
      items: Array<{ itemId: number; fields: TaskFields }>;
    }
  | {
      proposalId: UUID;
      kind: "update_task";
      taskId: UUID;
      expectedVersion: number;
      changes: Changes;
    };
```

Batch items are a nonempty unique subset of the persisted itemIds (max 5); users may edit fields/select items, not append unseen items. Canonicalize to ascending itemId before comparison. A source link can be cleared; a non-null sourceNoteId must equal that item's persisted retrieved source and be currently authorized in the target project. A different source requires a new proposal; no arbitrary model-supplied source links. Revalidate source ownership/project at confirmation, including after waits. If the source timestamp changed, conflict and require a new extraction/review rather than silently treating the old excerpt as current. Clearing a link does not bypass checking the evidence actually used. The user can instead create an independent manual task.

Receipts are immutable discriminated objects storing **the entire canonical approved request excluding proposalId and the outer kind discriminator**, plus result identities:

```ts
type Receipt =
  | {
      schemaVersion: 1;
      kind: "create_project";
      approved: { name: string; description: string | null };
      result: { projectId: UUID };
    }
  | {
      schemaVersion: 1;
      kind: "create_tasks";
      approved: { projectId: UUID; items: Array<{ itemId: number; fields: TaskFields }> };
      results: Array<{ itemId: number; taskId: UUID; projectId: UUID; version: 1 }>;
    }
  | {
      schemaVersion: 1;
      kind: "update_task";
      approved: { taskId: UUID; expectedVersion: number; changes: Changes };
      result: { taskId: UUID; projectId: UUID; version: number; changed: boolean };
    };
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

## 4. Smallest AI orchestration change (approved design; implemented in P5.4C)

The baseline limitations and future-tense design below are retained for traceability. Section 7 records the implemented grammar and verification boundaries.

Current stream handler exposes automatic tool selection, executable read-only searchNotes and schema-only prepareNote; one search/five 320-character excerpts, two steps, 1,024 output tokens shared across steps, 20,000 JS-unit visible text/arguments, 120-second provider deadline, no retries/parallel calls. It explicitly disables **all** tools in step two and rejects calls outside step one. Prompt currently says text-only after retrieval. These are actual blockers to search → task preparation, not solved by adding a tool description.

Later implementation should add only schema-only `prepareProject` (Main-only) and `prepareTasks`, without execute or database capability. Keep current automatic tool choice. Direct user-message extraction/project preparation takes one generation step; a search-assisted task draft may take the **existing** second step. Do not add a third step, repair inference, retry, larger budget or a full-note fetch in this slice.

- Step one allows ordinary text, exactly one note/project/task preparation, or exactly one search. Keep existing prepareNote behavior; no note-proposal refactor or new post-search prepareNote path.
- After a valid search result, step two allows text **or one prepareTasks**, no search, prepareProject or prepareNote. Revise prepareStep activeTools/toolChoice and stream input/call/result/finish validation together. Permit exactly search → preparation (two calls total across separate steps), never two preparation tools or search + preparation in one step. Preserve search result integrity, per-turn cumulative token/argument limits and output-exhaustion failure. New post-search proposal completion must atomically persist sourceRefs too; current completeProposal has no such path.
- Tool contracts are smaller than persisted drafts: project `{name,description}`; task `{items:[{title,description,status,priority,assignee,dueDate,evidence: {type:'user_message'} | {type:'retrieved_note', ordinal:1..5}}]}`. All nullable keys required, max five, strict nested objects. No owner/project/task IDs, timestamps, itemId, sourceNoteId, status of proposal or receipt from the model. The server assigns itemIds, maps ordinal to this turn's actual authorized retrieval result and builds the persisted envelope. Revalidate at completion; forged/missing ordinals or outside-scope sources fail closed.
- The current search payload is bounded excerpts, **not full note content**. Persist excerptOnly:true for all retrieved evidence. Never claim all action items were extracted, absence of more tasks, or a full-note review; request pasted substantive content or clarify when the excerpt omits necessary context. No silent full-note reading, invented completion or concatenating unrelated sources. Keep retrieved instructions as inert data; tools may extract described work, not execute embedded commands. Semantic grounding still requires provider/PM acceptance.
- P5.5 may add a bounded read-only task lookup using existing owned get/list services, returning server-verifiable taskId/projectId/version, and a schema-only prepareTaskUpdate. One retrieval step followed by one preparation step fits the same two-step cap. A flow needing note search plus task search plus preparation does **not** fit: split into explicit user turns or seek separate budget approval. Do not trust old assistant prose as current task identity/version. The reserved update draft/receipt supports this without another table migration; no task lookup/update tool is implemented now.
- Current transport `sourcesMatchMessage` disallows sources on a note `proposal`; retain that rule while allowing sources alongside the separate managementProposal field. Coordinated future server/transport/client validators must bind management proposal IDs to assistant/conversation/turn; no actionable identity from provisional deltas. Emit only after commit, with deterministic no-write text for tool-only drafts. Existing `persisted:true` means assistant/proposal persisted, not project/task created. Preserve existing note confirmation and revocable source behavior.

## 5. Approval and evidence boundaries

PM approved the one-table design, max-five/single-project atomic selection, strict payload/receipt shapes and caps, first-confirmation source-change conflict and unavailable-result replay for P5.4B. P5.4C's second-step/tool/client/UI changes were separately authorized and are recorded below; P5.5 was subsequently authorized by its implementation task (Section 8); migration execution remains unauthorized.

No live PostgreSQL CHECK/FK/MVCC/lock/rollback or performance evidence, provider grounding, or UI acceptance is claimed. Later focused tests must cover corrupt JSON, ownership/scope denial, mixed proposal rejection, canonical replay/subset conflicts, all-or-none batch failure, source changes, manual-update races, task deletion before/after replay, conversation deletion lock ordering, lost acknowledgements, stream cardinality/limits and revoked result links. Real database/provider/browser checks require separate authorization.

## 6. P5.4B implemented backend

- `packages/db/src/schema/management-proposals.ts`: exact approved table, five CHECKs, source UNIQUE/RESTRICT FK, no result FKs or extra indexes. Generated by installed Kit 1.0.0-rc.5 using `cd packages/db && bun run db:generate --name management_proposals`. SQL has only CREATE TABLE and ALTER TABLE ADD FK; v9 snapshot has 17 create deltas and extends task snapshot `573796db-74aa-43da-83d0-68621e8fa9a8`. Historical migrations are unchanged.
- `chat/management-contracts.ts`: strict draft/confirmation/receipt unions, shared manual validators, nullable fields, canonical UUIDs/title/name, sequential draft item IDs, sorted unique selections, JSON byte limits and receipt identity mapping. `update_task` contracts exist but both finalization and confirmation reject execution. The trusted future orchestrator, not a model/client, must assign item IDs and resolve retrieval ordinals before calling completion; semantic extraction checks remain P5.4C.
- Internal `chat.completeManagementProposal`: fresh-session conversation UPDATE lock, user/completed and assistant/pending identity, scope/deadline/source checks, atomic completion/sourceRefs/proposal/activity, exact terminal replay. Note completion/confirmation exclude management sources; management reads/confirmation reject mixed sources. Existing note schema/receipt semantics stay intact.
- `workspace.confirmManagementProposal`: fresh-session conversation SHARE → proposal UPDATE → owned target project SHARE → selected evidence-note SHARE locks in UUID order. Shared private creation cores preserve manual project/task creation behavior without nested transactions. Task creation may reacquire already-held project/note SHARE locks, never acquire a new lower-order resource. Batch selection, editable fields and evidence are checked before inserts; cleared source links do not skip evidence. Project/task inserts and immutable receipt commit together. Exact replay compares canonical approval without checking mutable source/task contents or rewriting timestamps; no deleted result is recreated.
- Shared read-only `chat/management-proposals.ts` validates stored state and batches authorized source/project/task projections. History queries only the current bounded message page; begin replay and get-by-ID return separate nullable `managementProposal` data. Public receipts contain current availability/links, not private approval or unavailable result IDs. Unavailable source IDs are also redacted from task draft fields/evidence. Confirmation returns `{proposal, replayed}` only after transaction completion; get-by-ID returns the same proposal view.
- Authenticated actions are only workspace `confirmManagementProposal` and chat `getManagementProposal`. Successful confirmation revalidates dashboard/projects/tasks plus authorized result paths. No finalization/receipt-write action or model tool is exposed. Main Chat deletion explicitly removes management then note proposals before messages/thread; confirmed knowledge is untouched.
- Focused tests use real Drizzle SQL over scripted non-network drivers and metadata/snapshot checks. They cover contracts, denials, successful project/full/subset/retrieved batches, evidence changes/clears, rollback requests/lost acknowledgements, exact/conflicting replay, revoked/deleted results, history/begin replay, deletion ordering and reserved updates. Ordered scripted confirmation-before/deletion-before cases and existing simulated note-confirmation locks are **not** live PostgreSQL concurrency/rollback evidence.

Deployment must not enable these readers/writers until the separately approved target has this migration. In particular, history now selects the management table; this backend is not backward-compatible with a database missing it. No live database/provider/browser check, migration application or deployment occurred in P5.4B.

## 7. P5.4C implemented integration

- The existing stream now advertises schema-only `prepareProject` (Main Chat only) and `prepareTasks`. Strict complete nullable task fields/evidence ordinals map to server-assigned item IDs, conversation scope and this turn's verified retrieval identities. Model arguments never supply authoritative project/note/task/owner IDs or timestamps. Literal valid ISO due dates must occur in the current message or the item's retrieved excerpt. Optional semantic support/default-status and inert-instruction guidance is in the existing prompt, not a claim of fully verified extraction.
- Step one permits text or exactly one preparation/search call; after one successful search, step two permits text or exactly one task preparation. Active tools and input/call/result/finish validation agree. Mixed/duplicate/out-of-step calls, malformed or unsupported data, incomplete/output-limited streams cannot persist actionable drafts. No post-search note/project preparation, third step, repair, retry, full-note read, task query/update or new execution capability. Existing cumulative token/character limits, search/excerpt bounds, timeout and provider settings remain unchanged.
- Only valid terminal output reaches `chat.completeManagementProposal`, including server-held sourceRefs after retrieval, without project/task writes. The existing terminal-write/cancellation boundary and history-first uncertain-finalization recovery remain in force. Custom SSE finish, begin replay, bounded history, get-by-ID recovery and cached Main/Project Chat state carry the separate nullable `managementProposal`; original note `proposal` remains independent and mutually exclusive. Client checks bind message/conversation/turn, scope, source/item/result identities and canonical links. Persisted chat/proposal status is not knowledge-creation success.
- Editable previews use existing styling and controls, explicit authenticated confirmation, required Main target selection from bounded owned-project pages, fixed Project Chat scope and a validated nonempty task subset. Users can edit nullable fields or clear—not replace—the original source link. First confirmation remains blocked for incompatible/unavailable/changed evidence, including after clearing a source link. Backend revalidation remains authoritative and all selected writes stay atomic.
- Uncertain creation preserves/locks the exact canonical submission in the existing view-local session. Get-by-ID recovery is read-only; a proposed read enables only explicit same-ID/same-payload retry, never automatic write retry or manual-create fallback. Confirmed receipts remain confirmed when results disappear, with no recreate controls. Because public receipts intentionally omit private approvals, original draft values are not labeled as final approved values.
- Source/result availability is revocable independently of confirmation. Cached-view invalidation strips links; only current authorized reads restore them. Acknowledgements invalidate earlier history reads; stale props/reads/callbacks cannot downgrade receipts, change their result selection or resurrect links after view invalidation/retirement. Full document reload can lose in-memory edits/submitted payload; it reads the server state and requires explicit review, never auto-submission. There is no browser-storage, cross-account or cross-tab cache.
- Verification is offline: SDK/mock provider plus Groq adapter/mock HTTP, transport/session/SSR and directly affected backend regressions. It does not establish live Groq schema acceptance/semantic grounding, PostgreSQL CHECK/FK/MVCC/locking/rollback, mounted interaction/accessibility or authenticated browser/visual/mobile acceptance. These remain separately approved/P5.6 checks. No schema/backend service/migration/dependency/auth-policy changes, live calls, migration execution, deployment or production build are included.

## 8. P5.5 implemented task retrieval and updates

P5.5 enables the already-reserved update family in this same eight-column table. No schema, migration artifact, dependency, authentication policy or deployment change. Existing project/batch and note proposal contracts remain intact; update changes explicitly exclude sourceNoteId and preserve that association.

- `workspace.searchTasks` performs bounded owner-filtered SQL before ordering/lookahead: optional literal title/project-name substrings, exact status or pending/non-Done, priority including null, inclusive due range, and overdueBefore (strictly earlier due date AND non-Done). The two-project name ambiguity lookup and eleven-task lookahead use one read-only repeatable-read snapshot. Maximum ten summaries, bounded 160-character description, deterministic updatedAt/id order; no collection fetch or global count. Main owner scope and fixed Project Chat scope come from server identity. The strict AI tool accepts names/filters, never IDs or ownership claims.
- No local date is available to the existing server request. Rather than add request/persisted timezone state, require explicit literal valid local calendar cutoff/range dates in the current user message. Date-only SQL comparisons never convert deadlines through UTC. A relative/overdue request without cutoff needs clarification.
- Only validated current-turn results become model reference data: ordinal, project name, bounded fields and current version, with IDs retained server-side. Total tool output remains below the existing 8,000-character retrieval bound; trimming sets truncated=true. Empty, partial/ambiguous and failure are distinct. Ordinary task Q&A stores no new search references or note sourceRefs. Task content is untrusted; current facts require retrieval and bounded results cannot support global counts/exhaustiveness or invented prioritization.
- Grammar: initial text, one existing preparation, searchNotes OR searchTasks. After notes: text/prepareTasks; after tasks: text/prepareTaskUpdate. One retrieval/two steps, existing cumulative budgets/timeout, no retry/parallel calls. No task-update preparation from note search, initial update, combined searches, third step or repair inference. Since P5.6C.1, schema-only prepareTaskUpdate has a separate strict provider contract: required ordinal, unique nonempty fieldsToChange, and a complete six-property changes object (nullable placeholders for unselected values), no execute. Every object has additionalProperties=false and all property keys required. Local selection/title/status/date validation normalizes only selected fields into the unchanged nonempty partial backend managementChanges; selected nullable fields may clear with null. Read-only searchTasks alone uses non-strict provider mode with optional filters, closed local validation and explicit no-restriction defaults. Neither change loosens persisted draft/receipt/confirmation or manual update contracts. Target/project/version resolve from private results. Conservative policy requires exactly one non-truncated task match and no ambiguous project filter; otherwise the second generation has no tools and may ask for a narrower query in another explicit turn or fixed Project Chat. New model due dates need literal evidence from current user text or that task's retrieved bounded data, not relative conversion.
- Finalization reauthorizes the target/project and SHARE-locks its captured current version after the conversation lock, before atomic assistant/proposal/activity persistence. Stale/missing/fixed-scope targets and fabricated note references fail closed. Exact terminal replay compares original content/draft/references without rechecking later mutable task state.
- First confirmation validates immutable taskId/projectId/expectedVersion and edited partial fields, then conversation SHARE → proposal UPDATE → owned project SHARE → target task UPDATE. A small private shared manual-update core checks version before no-op, preserves omitted fields/source note, handles null clears, increments meaningful changes, rejects overflow and retains Done/reopen semantics. No separately committing public service, automatic overwrite or refreshed expectedVersion. Task update, receipt/status/confirmedAt commit together; missing RETURNING, receipt/SQL/commit failure cannot report success. No-op leaves task timestamps/version untouched but records explicit confirmation.
- Confirmed replay compares the entire canonical immutable approval; changed payload conflicts, exact replay never executes a task write or checks the old version again. Later edits/deletion do not invalidate confirmation. Public receipt keeps durable changed/result-version separately from current authorized result availability; private approvals and unavailable result IDs stay private. No result is recreated.
- Existing batched history/replay/get-by-ID projection includes minimum authorized current target/project fields, proposed changes and fixed expectedVersion. Missing/foreign/moved targets have no IDs/links/current fields. Public target fields are read-time values, not an invented historical snapshot. Custom SSE/transport/cached sessions retain identity/scope/receipt bindings and note mutual exclusion. Cache invalidation strips target/result links; fresh reads restore only currently authorized availability. Proposed recovery can refresh current fields but never replaces expectedVersion or an uncertain canonical submission.
- The existing preview has an update variant with fixed identity/version, current versus proposed fields, checkboxes preserving omission, editable six-field changes and explicit Confirm update. Stale targets require a new reviewed proposal; unavailable/invalid targets block first confirmation. Uncertain submissions stay locked with read-only checks and explicit same-payload retry. Durable changed/no-change state is not result availability; original draft changes are never labeled final approved values. Late/retired acknowledgements cannot restore state. No browser storage, new chat-state infrastructure or task-form/card redesign.

Offline SQL-builder/scripted-driver, SDK/provider-mock, transport/session and SSR tests are not live PostgreSQL CHECK/FK/MVCC/locking/rollback, live Groq grounding/schema support or mounted/authenticated visual/mobile acceptance. Final live/visual checks remain P5.6 and were not started. No database/provider connection, migration generation/execution, deployment, commit or push is part of this implementation.
