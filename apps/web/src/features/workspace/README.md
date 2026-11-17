# Phase 1D workspace backend

## Entry points

- Server Components / future server-side tool handlers import `workspace` from `./server`.
- Client UI imports the eight async functions from `./actions` (Next.js Server Functions).
- Do not instantiate `createWorkspaceService` with client/model identity. Its dependency seam is only for trusted server composition and offline tests. `server.ts` is guarded with `server-only` and obtains a fresh Better Auth session from request headers on every operation.
- All operations enforce session, validation and ownership internally. Actions contain no duplicate business logic. No extra HTTP API, frontend or cache is introduced; Phase 1E must refresh its views after successful mutations.

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

Inputs are accepted as `unknown` at the boundary and validated with strict Zod schemas in `contracts.ts`. Unknown keys, including `ownerId`/`userId`, are rejected. Project and note updates require at least one allowed change. `projectId` in note updates is the original resource scope, never a reassignment field.

Limits: project names 200 characters, descriptions 5,000, titles 300, content 100,000 (JavaScript string lengths). Names/titles are trimmed and must be nonblank; content must contain non-whitespace text and is stored **without trimming or transformation**. Dates are nullable, strictly validated `YYYY-MM-DD` calendar dates, years 0001–9999, never defaulted from creation time. Omitted date/description on creation becomes null; omission on update preserves the current value, explicit null clears it.

Lists default to 50 rows, maximum 100, with offset 0–100,000. Ordering is `updatedAt DESC, id DESC`. Offset pagination is deterministic for a fixed dataset, not a stable snapshot across concurrent edits. DTOs expose explicitly selected domain fields, not owner IDs or auth data; timestamps are Date values supported by React Server Function serialization.

## Note revision transaction

`updateNote` starts a READ COMMITTED transaction and locks the ownership-scoped note using `FOR UPDATE OF notes`. Only then, in a separate statement, it reads the largest stored snapshot version. This avoids allocating a version using an old statement snapshot after waiting for another writer's lock. The outgoing version is `max(snapshot.version) + 1`, or 1 without history.

A mismatched `expectedVersion` returns `CONFLICT`, even for a stale no-op. A current no-op returns the unchanged note/version without writes. Meaningful title/content/date changes insert the outgoing snapshot, then update the same ownership-scoped note; exceptions and missing update results throw inside the transaction. Successful data is returned only after commit. The row lock serializes writers using this protocol; the database unique constraint is the final duplicate guard. Integer exhaustion is rejected instead of overflowing revision numbering.

Creation checks and share-locks the owned parent before inserting a note. Neither creation nor any operation reassigns ownership/projects or deletes data. Current-state writes outside this service would violate the revision protocol and must not be introduced.

## Verification boundary and pending integration checks

Run `bun test apps/web/src/features/workspace/workspace.test.ts`. Tests use the real Drizzle builder with a scripted, non-network driver, checking session/validation denial, parameterized ownership scopes, DTOs, version transitions, no-ops/stale edits and transaction rollback **requests**. No real database is contacted. They do not establish database rollback, lock scheduling or cross-account persistence correctness.

Before runtime use, PM must approve a disposable PostgreSQL development target and the Phase 1C migration/baseline and Supabase Data API exposure review. Pending tests: two-user persisted isolation; independent connection races with the same version (one success, one conflict); later sequential edits without duplicate/gapped snapshots; genuine rollback after injected update/snapshot/commit failures; calendar-date/timestamp round trips; and authenticated Server Function/browser integration. No schema changes, migrations or owner provisioning were executed here.

No automatic retries are performed. On an uncertain network/commit failure, reload state before retrying a write; create operations do not yet have idempotency keys. Rate limiting, project optimistic concurrency and revision-history browsing are not introduced in this phase.
