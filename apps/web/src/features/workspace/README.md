# Workspace backend and functional frontend

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

## Note revision transaction

`updateNote` starts a READ COMMITTED transaction and locks the ownership-scoped note using `FOR UPDATE OF notes`. Only then, in a separate statement, it reads the largest stored snapshot version. This avoids allocating a version using an old statement snapshot after waiting for another writer's lock. The outgoing version is `max(snapshot.version) + 1`, or 1 without history.

A mismatched `expectedVersion` returns `CONFLICT`, even for a stale no-op. A current no-op returns the unchanged note/version without writes. Meaningful title/content/date changes insert the outgoing snapshot, then update the same ownership-scoped note; exceptions and missing update results throw inside the transaction. Successful data is returned only after commit. The row lock serializes writers using this protocol; the database unique constraint is the final duplicate guard. Integer exhaustion is rejected instead of overflowing revision numbering.

Creation checks and share-locks the owned parent before inserting a note. P3.3 extracts this unchanged SQL/response behavior into private `lockOwnedProject`/`createNoteInTransaction` helpers, shared by manual create and confirmation under their own outer transaction. No raw insert primitive is exported. Neither creation nor any operation reassigns ownership/projects or deletes data. Current-state writes outside this service would violate the revision protocol and must not be introduced.

## P3.3 confirmation transaction

Confirmation authenticates/validates, discovers an authorized completed assistant source, then takes a conversation SHARE lock, proposal UPDATE lock with fresh source predicates, and selected owned-project SHARE lock in that order under READ COMMITTED. Scoped conversations cannot target a different project; general conversations require an explicitly selected owned project. Missing/foreign resources deny identically.

A proposed row inserts one version-1 note through the shared private core and atomically fills approved project/title/content/date, note ID, status and database confirmation time. Any failure rolls back both writes. Exact confirmed replay compares the immutable approved fields, verifies the current note's project/ownership, returns its original ID and changes nothing; later normal note edits do not invalidate replay. A changed payload conflicts. The proposal row lock, not a disabled button, serializes confirmations, without another key/table. Successful actions revalidate dashboard/project/note views only after commit; confirmation does not reorder chat history.

`note-confirmation.test.ts` adds offline SQL/denial/rollback/replay tests and a deterministic proposal-mutex/commit simulator, including two simultaneous identical/different confirmations and lost acknowledgement. The chat state tests cover explicit Save, immutable in-memory pending payload, read-only recovery, explicit same-payload retry, stale receipts and SSR controls. This is not live PostgreSQL concurrency/rollback or browser proof. See `docs/NOTE_PROPOSALS.md`; stop for review before P3.4.

## Verification boundary and pending integration checks

Run `bun test apps/web/src/features/workspace/workspace.test.ts`. Tests use the real Drizzle builder with a scripted, non-network driver, checking session/validation denial, parameterized ownership scopes, DTOs, version transitions, no-ops/stale edits and transaction rollback **requests**. No real database is contacted. They do not establish database rollback, lock scheduling or cross-account persistence correctness.

The existing development schema/backend access and Data API-disabled boundary are PM-confirmed; P3.3 adds no migration or permission change. P3.4 real write/concurrency tests need separate approval for an exact disposable PostgreSQL target, fixtures and cleanup. Pending tests: two-user persisted isolation; independent connection races with the same version (one success, one conflict); later sequential edits without duplicate/gapped snapshots; genuine rollback after injected update/snapshot/commit failures; calendar-date/timestamp round trips; and authenticated Server Function/browser integration. No schema changes, migrations or owner provisioning were executed here.

No automatic retries are performed. On an uncertain network/commit failure, reload state before retrying a write; manual create operations do not have idempotency keys; P3.3 proposal confirmation uses its existing proposal ID and immutable receipt. Rate limiting, project optimistic concurrency and revision-history browsing are not introduced in this phase.
