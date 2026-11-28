# Workspace backend and functional frontend

**Current status:** Phase 1 manual workspace and Phase 3 proposal confirmation are implemented; Phase 3 and the P3.4B chat sign-out warning fix are merged through PR #1 (`0ca0856`). Phase headings describe implementation history, not pending authorization to build these existing features. Live integration checks below are deferred evidence, not completed tests.

## Entry points

- Server Components / future server-side tool handlers import `workspace` from `./server`.
- Client UI imports authenticated async functions from `./actions` (Next.js Server Functions), including the dedicated P3.3 `confirmNoteProposal` action.
- Do not instantiate `createWorkspaceService` with client/model identity. Its dependency seam is only for trusted server composition and offline tests. `server.ts` is guarded with `server-only` and obtains a fresh Better Auth session from request headers on every operation.
- All operations enforce session, validation and ownership internally. Actions contain no duplicate business logic or extra HTTP API. Phase 1E adds path revalidation to successful mutation adapters, without changing the domain operations or response contracts.

## Phase 1E frontend

- `(workspace)` routes provide the authenticated shell, dashboard, project list/create/detail/edit, and note create/edit screens. Server pages call `workspace` directly; client forms and pagination call the existing Server Functions. The shell's session gate is not a replacement for per-operation authorization.
- Projects and notes initially load 50 rows, with explicit Load more, raw-page offsets and ID deduplication. No synthetic counts or fabricated production data are shown. Successful writes revalidate affected dashboard/project/note paths; clients refresh after confirmed success.
- The note editor uses an explicit save and the last confirmed `expectedVersion`. Failed saves retain the exact draft and original version. Conflicts block further saves; loading the latest version is comparison-only. Replacing the draft requires confirmation and adopts that returned version. A subsequent remote edit is still handled by the normal conflict protocol. There is no overwrite/force-save endpoint or automatic retry.
- Meaningful field changes, including whitespace, are tracked in memory. Normal same-tab links and full-page unloads warn before leaving; same-document Back/Forward uses cancellable Navigation API events where supported. Browsers without that API (or a cancellable event) cannot reliably block SPA history traversal. No private Next.js history APIs, synthetic history entries, local-storage copies or automatic knowledge writes are introduced. Accepting a leave/replacement warning intentionally discards the draft.
- Expired-session feedback opens login in another tab so the draft remains available. Uncertain creates direct users to check the existing list in another tab before retrying. Drafts are not durable after a browser/process crash or an accepted navigation.
- App-local styles follow `docs/DESIGN.md`: Geist, navy night-sky background, selective navigation glass with an opaque fallback, opaque readable list/editor surfaces, accessible focus and reduced-motion rules. No new UI framework or dependency is added.

Run `bun test apps/web/src/features/workspace/frontend.test.tsx` for offline reducer, validation, pagination, date and safe-rendering coverage. These tests do **not** establish authenticated browser or PostgreSQL integration.

## P4.6F form refinement

App-owned `.form-control` fields (including note search and proposal edits) and the chat composer now use background `#1c1e25` and normal border `#363a42`. Normal-border rules exclude focused/invalid fields so existing blue focus and error-first red borders retain authority. Shared primitives and login remain unchanged.

Note and Project save actions sit at the upper right, with adjacent quiet unsaved/saving/meaningful-saved feedback. Clean forms have no permanent saved/new-state filler. Project's redundant bottom Cancel/footer and optional-description helper, Note's plain-text helper and unsaved new-note metadata filler are removed; labels, date guidance, saved timestamps/version, contextual validation, mutation errors and unsaved guards remain. Note content is now approximately 160px high (viewport capped), non-resizable and internally scrolling; full-width forms, exact content/date submission, optimistic versions and explicit conflict replacement are unchanged.

## P4.6E UI refinement

New/Edit Note now fill their existing canvas content width, like Project Forms. Workspace/proposal fields share rounded primitive borders and an app-local raised neutral surface, with border-only focus and error-first invalid styling. Login and the shared Input/Textarea primitives are unchanged. Description, note content, read-only comparison and proposal textareas have fixed, viewport-bounded heights with internal scrolling and no drag resizing; the chat composer follows the same fixed-sizing policy.

`fieldErrors` maps the existing Zod issue paths/codes/maximums to contextual English without displaying raw schema messages or internal paths. Workspace forms remain submit-first, focus the first invalid field, and revalidate only a field with an existing error as it changes. Optional native date input bad/range validity also receives the same safe date message rather than silently treating an incomplete typed date as blank. Shared schema rules/limits, exact draft content, mutation error handling, confirmed versions, comparison-only reads, explicit replacement and unsaved guards remain unchanged.

Project Detail renders the description once, directly below its title inside the header above its divider. The expanded header scrolls normally (rather than pinning potentially 5,000 characters over the notes); the Created date stays below it in the content area. Existing project actions and the contextual popup are retained.

Offline tests and synthetic mounted-browser/style checks are not authenticated Next/RSC or live PostgreSQL evidence; PM visual/mobile acceptance remains separate.

## Contracts

Every operation returns `Promise<WorkspaceResult<T>>`: either `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. Codes are `UNAUTHENTICATED`, `INVALID_INPUT`, `NOT_FOUND`, `CONFLICT`, and `UNAVAILABLE`. Missing and foreign-owned resources deliberately share `NOT_FOUND`. Unexpected session/driver errors return a generic message, without SQL or secrets.

| Operation       | Input object                                                          | Successful data                        |
| --------------- | --------------------------------------------------------------------- | -------------------------------------- |
| `listProjects`  | `{ limit?, offset? }`, defaults to `{}`                               | Project DTO array                      |
| `getProject`    | `{ projectId }`                                                       | Project DTO                            |
| `createProject` | `{ name, description? }`                                              | Project DTO                            |
| `updateProject` | `{ projectId, name?, description? }`                                  | Project DTO                            |
| `listNotes`     | `{ projectId, limit?, offset? }`                                      | Note summary array, without content    |
| `getNote`       | `{ projectId, noteId }`                                               | Full note DTO plus logical `version`   |
| `createNote`    | `{ projectId, title, content, noteDate? }`                            | Full note DTO with `version: 1`        |
| `updateNote`    | `{ projectId, noteId, expectedVersion, title?, content?, noteDate? }` | Full note DTO plus resulting `version` |

`confirmNoteProposal({ proposalId, projectId, title, content, noteDate: string | null })` returns `{ proposalId, noteId, projectId, href, replayed }` only after commit. Its strict shared confirmation contract lives in `../chat/contracts.ts`; the explicitly nullable date is required and all text rejects NUL/lone surrogates. It is a user action, not a model tool.

Inputs are accepted as `unknown` at the boundary and validated with strict Zod schemas in `contracts.ts` (or the shared confirmation contract). Unknown keys, including `ownerId`/`userId`, are rejected. Project and note updates require at least one allowed change. `projectId` in note updates is the original resource scope, never a reassignment field.

Limits: project names 200 characters, descriptions 5,000, titles 300, content 100,000 (JavaScript string lengths). Names/titles are trimmed and must be nonblank; content must contain non-whitespace text and is stored **without trimming or transformation**. Dates are nullable, strictly validated `YYYY-MM-DD` calendar dates, years 0001–9999, never defaulted from creation time. Omitted date/description on creation becomes null; omission on update preserves the current value, explicit null clears it.

Lists default to 50 rows, maximum 100, with offset 0–100,000. Ordering is `updatedAt DESC, id DESC`. Offset pagination is deterministic for a fixed dataset, not a stable snapshot across concurrent edits. DTOs expose explicitly selected domain fields, not owner IDs or auth data; timestamps are Date values supported by React Server Function serialization.

## Read-only note search

- Existing `searchNotes({ projectId, query, limit?, offset? })` remains project-scoped, including its owned-project precheck and shared `NOT_FOUND` response for foreign/missing projects. Its UI and chat callers are unchanged.
- `searchOwnedNotes({ query, projectId?, limit?, offset? })` is a separate backend-only operation for all projects of the fresh server-session owner. An optional project UUID narrows the same ownership-filtered query; foreign/missing filters return `{ ok: true, data: [] }`, without revealing project existence or names. No client action or AI integration is added in P4.6A.
- Both strict contracts accept a trimmed literal query of 1–200 JavaScript string units, limit 1–50 (default 20), and offset 0–100,000 (default 0). Unknown identity/override fields are rejected. Search is case-insensitive title-or-content substring matching with escaped `%`, `_`, `!` and literal backslashes, never tokenized or semantic search.
- Owner-wide results are `{ id, projectId, projectName, title, excerpt, noteDate, updatedAt }`. `projectName` comes from the same inner-joined owned parent, excluding absent/inaccessible parents. No owner IDs, project descriptions or full note bodies are returned. Excerpts retain the 320-PostgreSQL-character bound and at most 80 characters before a content match; note dates remain nullable and distinct from edit timestamps.
- Ordering across projects is title match first, then `notes.updatedAt DESC, notes.id DESC`. Pagination is deterministic for an unchanged dataset, not a snapshot across edits. SQL enforces row/excerpt bounds; a limit bounds returned rows, not all search work.
- Existing owner/project B-tree indexes support scope/join filtering, but do not accelerate arbitrary leading-wildcard text matching. No migration/index change is required for this MVP baseline; live plans/performance and persisted cross-account isolation are not established by the scripted tests. P4.6B now integrates this read into Main Chat and authorizes cross-project source projections; fixed-project chats retain their original scope.

## P5.2 tasks — backend only, migration not applied

PM approved structured task persistence and local migration generation for Phase 5 Project Management Assistant. This extends the existing authenticated workspace service and thin Server Actions; no task UI, routes, navigation, AI tools or prompts are added.

- `createTask({ projectId, title, description?, status?, priority?, assignee?, dueDate?, sourceNoteId? })`: defaults status to `todo`, nullable fields to null and version to 1. Initial `done` sets `completedAt`.
- `getTask({ taskId })`: full task DTO, no account metadata.
- `listTasks({ projectId, status?, priority?, dueDateFrom?, dueDateTo?, limit?, offset? })`: requires an owned project; foreign/missing projects share NOT_FOUND.
- `listOwnedTasks({ projectId?, status?, priority?, dueDateFrom?, dueDateTo?, limit?, offset? } = {})`: joins only session-owned projects. Foreign/missing optional project filters both return an empty collection.
- `updateTask({ taskId, expectedVersion, title?, description?, status?, priority?, assignee?, dueDate?, sourceNoteId? })`: requires a change field; project assignment is immutable. Omission preserves a value; explicit null clears a nullable field.
- `deleteTask({ taskId, expectedVersion })`: permanent deletion of that task only, returning `{ id, projectId }` after commit. Its project, source note, note revisions and chat history remain untouched. A lost acknowledgement is not idempotent success; reload before retrying.

All six operations obtain a fresh server-side session and use project-derived ownership predicates. Source notes are checked against the same owned project and share-locked within create/update transactions; a single-column note FK alone does not enforce same-project scope. Missing, foreign and mismatched sources deny identically. No owner field or model-supplied identity is accepted.

Status is `todo | in_progress | blocked | done`; priority is `urgent | high | medium | low | null`. Titles are trimmed/nonblank, maximum 300 JavaScript string units; descriptions and plain-text PIC/assignee names are nullable, maximum 5,000 and 200. Original description/assignee whitespace is preserved. All task text rejects NUL and unpaired surrogates. Due dates use validated calendar strings, years 0001–9999; bounds are inclusive and must be ordered. A due-date filter excludes undated tasks. Overdue is derived, not a stored status or timezone-driven mutation.

Lists default to 50/max 100 rows and offset 0–100,000. Filters execute before pagination; ordering is `updatedAt DESC, id DESC`. Summaries omit descriptions and add only the authorized `projectName`; offset pagination is not a snapshot across concurrent edits. Project/activity and project/due-date indexes support the required project queries; owner-wide performance remains unmeasured.

Updates/deletions lock the owned task under READ COMMITTED and check `expectedVersion`, retaining owner/version predicates on the final write. Stale no-ops conflict; current no-ops preserve version/timestamps. Meaningful edits increment version, rejecting integer exhaustion. Entering done sets completion, editing while done preserves it, leaving done clears it; all manual transitions are allowed. Successful mutation actions revalidate existing dashboard/project views, never unfinished task routes. No task revision history or automatic retries are introduced.

`tasks.test.ts` and `packages/db/src/tasks-schema.test.ts` use the existing offline SQL/metadata pattern. They do not prove real PostgreSQL constraints, locks, rollback or persisted account isolation. The additive generated SQL and execution prerequisites are documented in `packages/db/src/migrations/README.md`; migration execution is separately gated.

## P5.3 manual task management

- `/tasks` lists the session owner's tasks; Tasks sits between Projects and Ask Solyn. `/tasks/new` requires selecting an owned project; `/tasks/new?projectId=<uuid>` authorizes and fixes that project. `/tasks/[taskId]` is the only task editor route.
- Project Detail defaults to Notes; `?view=tasks` uses the same task-list component with fixed-project `listTasks`. Existing project metadata, Note Search/collection pagination and Project Chat remain. Only the selected tab's collection is queried.
- Status, priority (including No priority), project and inclusive due-date filters use the P5.2 backend. GET-compatible forms and Previous/Next links retain filters in the URL, resetting offset on filter application. Pages contain at most 50 tasks, grouped by status within that page; loaded/page counts never claim a dataset total.
- Global project choices and project source-note choices load bounded pages with retry and raw-page offsets. Changing a creation project clears its source. An existing outside-page source is retained on unrelated edits; source links use authorized note metadata, not a supplied ID alone. Choices beyond the first page remain reachable within existing backend pagination bounds.
- The task form reuses the approved full-width header/fields, native submit, explicit save and unsaved guard. Update payloads contain only changed fields and the last confirmed version; nullable clears are explicit nulls. Descriptions/PIC preserve exact whitespace. Completion is server-managed, never client timestamp input.
- List Done/Reopen controls wait for confirmation and refresh the current filtered view. Conflicts and ambiguous outcomes direct users to the canonical editor for review rather than silently retrying. The editor loads latest state for comparison only; explicit replacement adopts its version. Uncertain creates require checking persisted tasks and explicit acknowledgement before retry. These are recovery controls, not new idempotency guarantees.
- Permanent delete identifies the saved task and unsaved-loss risk, requires confirmation/version, and navigates to project tasks only after success. Pending/deleted state prevents duplicate mutations. Failure preserves the draft; uncertain deletion never pretends the task is gone.
- Due dates use existing date-only formatting. Overdue is derived after hydration from the user's local calendar, refreshed at local midnight and on focus/visibility changes; today, undated and Done tasks are excluded. No persisted status, reminders or timezone-based backend mutations are added.
- Successful task actions additionally revalidate `/tasks` and the canonical task route, while retaining existing dashboard/project revalidation. No schema, migration, permission, AI or dependency changes are part of P5.3.

`task-frontend.test.tsx` covers the real view-local editor controller with offline action fixtures, payload/filter/date helpers, route/layout wiring and shared breadcrumb rendering. Source-level assertions are not mounted DOM interactions. Actual localhost visual/functional, keyboard, responsive and authenticated database acceptance remain PM-owned; no standalone browser harness or live data writes are used here.

## Note revision transaction

`updateNote` starts a READ COMMITTED transaction and locks the ownership-scoped note using `FOR UPDATE OF notes`. Only then, in a separate statement, it reads the largest stored snapshot version. This avoids allocating a version using an old statement snapshot after waiting for another writer's lock. The outgoing version is `max(snapshot.version) + 1`, or 1 without history.

A mismatched `expectedVersion` returns `CONFLICT`, even for a stale no-op. A current no-op returns the unchanged note/version without writes. Meaningful title/content/date changes insert the outgoing snapshot, then update the same ownership-scoped note; exceptions and missing update results throw inside the transaction. Successful data is returned only after commit. The row lock serializes writers using this protocol; the database unique constraint is the final duplicate guard. Integer exhaustion is rejected instead of overflowing revision numbering.

Creation checks and share-locks the owned parent before inserting a note. P3.3 extracts this unchanged SQL/response behavior into private `lockOwnedProject`/`createNoteInTransaction` helpers, shared by manual create and confirmation under their own outer transaction. No raw insert primitive is exported. Neither creation nor any operation reassigns ownership/projects or deletes data. Current-state writes outside this service would violate the revision protocol and must not be introduced.

## P3.3 confirmation transaction

Confirmation authenticates/validates, discovers an authorized completed assistant source, then takes a conversation SHARE lock, proposal UPDATE lock with fresh source predicates, and selected owned-project SHARE lock in that order under READ COMMITTED. Scoped conversations cannot target a different project; general conversations require an explicitly selected owned project. Missing/foreign resources deny identically.

A proposed row inserts one version-1 note through the shared private core and atomically fills approved project/title/content/date, note ID, status and database confirmation time. Any failure rolls back both writes. Exact confirmed replay compares the immutable approved fields, verifies the current note's project/ownership, returns its original ID and changes nothing; later normal note edits do not invalidate replay. A changed payload conflicts. The proposal row lock, not a disabled button, serializes confirmations, without another key/table. Successful actions revalidate dashboard/project/note views only after commit; confirmation does not reorder chat history.

`note-confirmation.test.ts` adds offline SQL/denial/rollback/replay tests and a deterministic proposal-mutex/commit simulator, including two simultaneous identical/different confirmations and lost acknowledgement. The chat state tests cover explicit Save, immutable in-memory pending payload, read-only recovery, explicit same-payload retry, stale receipts and SSR controls. This is not live PostgreSQL concurrency/rollback or browser proof. See `docs/NOTE_PROPOSALS.md` for the merged implementation, warning fix and verification limits.

## Verification boundary and pending integration checks

Run `bun test apps/web/src/features/workspace/workspace.test.ts`. Tests use the real Drizzle builder with a scripted, non-network driver, checking session/validation denial, parameterized ownership scopes, DTOs, version transitions, no-ops/stale edits and transaction rollback **requests**. No real database is contacted. They do not establish database rollback, lock scheduling or cross-account persistence correctness.

The existing development schema/backend access and Data API-disabled boundary are PM-confirmed; P3.3 adds no migration or permission change. Any real write/concurrency tests need separate approval for the exact non-production target, synthetic fixtures and cleanup; the following historical scenarios are not permission to execute them or a requirement for new test infrastructure. Pending tests: two-user persisted isolation; independent connection races with the same version (one success, one conflict); later sequential edits without duplicate/gapped snapshots; genuine rollback after injected update/snapshot/commit failures; calendar-date/timestamp round trips; and authenticated Server Function/browser integration. No schema changes, migrations or owner provisioning were executed here.

No automatic retries are performed. On an uncertain network/commit failure, reload state before retrying a write; manual create operations do not have idempotency keys; P3.3 proposal confirmation uses its existing proposal ID and immutable receipt. Rate limiting, project optimistic concurrency and revision-history browsing are not introduced in this phase.
