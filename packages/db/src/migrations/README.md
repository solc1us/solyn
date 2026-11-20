# Migration reviews and current development status

**Current implementation status:** Phase 3 is merged through PR #1 (`0ca0856`); the schema/migration artifacts below are unchanged by the P3.4B warning fix. PM approved the proposal migration and implementation, confirmed backend access, and reconfirmed **Data API disabled**. A bounded read-only check against the independently guarded development target found `public.note_proposals` and verified effective backend SELECT/INSERT privileges over an encrypted, authorized client connection. This is access evidence, not an executed insert or full constraint/migration-history audit. No migration was applied/reapplied by the agent in P3.2; Data API confirmation is not an outstanding blocker.

The NOT APPLIED labels in the Phase 1C/2B reviews below record those earlier offline implementation stages, not the present remote state. Do not reapply old migrations on the basis of those historical labels. Production, permission changes and disposable database-write tests still require separate approval.

## P4.4B — durable retrieved-note references (local artifacts only, NOT APPLIED)

Generated with the installed Drizzle Kit **1.0.0-rc.5**, using the existing PostgreSQL schema/output paths without loading runtime credentials:

```sh
cd packages/db
bunx --no-install drizzle-kit generate --dialect postgresql --schema ./src/schema/index.ts --out ./src/migrations --name chat_source_refs
```

Artifacts: `20261120105833_chat_source_refs/{migration.sql,snapshot.json}`. Reviewed SQL contains exactly two statements: add nullable JSONB `chat_messages.source_refs` (no default), and add `chat_messages_sources_consistent`. The CHECK uses CASE to allow SQL NULL, otherwise require an array of 1–5 entries on completed assistant messages. Strict field/UUID/timestamp/unique-note/scope validation remains in the application. JSONB does not add per-note FKs or authorization guarantees.

The v9 diff snapshot points to the existing proposal snapshot and contains exactly two create deltas (column and CHECK), with corresponding add-column/add-check footprints. No old migration changed; no unrelated schema delta, table, index, drop, data rewrite/backfill, grant, policy or auth change is included. Application completion stores only ordered note/project IDs and retrieval edit timestamps, atomically with the answer; public links require current ownership checks.

**No database connection, migration application or fixture write was performed.** Deployment must wait for PM approval of this exact SQL and the independently identified development target, migration-history/baseline compatibility, existing backend-only exposure protections and backup/recovery/DDL-lock timing. Apply the nullable-column migration before deploying code that selects it; old rows remain NULL without backfill. Actual PostgreSQL CHECK/transaction behavior and authenticated source navigation require separately approved verification; offline metadata/scripted SQL tests do not prove those properties.

## Phase 1C migration review — historical offline review

Generated with Drizzle ORM / Kit **1.0.0-rc.5**, using the existing config and `bun run db:generate --name core_workspace`.

## Artifacts

- `20261117115340_core_workspace/migration.sql`
- `20261117115340_core_workspace/snapshot.json` (Kit v9 snapshot format)

There was no prior migration snapshot, only `.gitkeep`. Consequently this is a full initial migration containing the four **unchanged** Better Auth tables (`user`, `session`, `account`, `verification`) plus three domain tables. Generation compares local schema to local migration history; it does **not** establish that a remote database is empty or compatible.

**Do not apply this unchanged to a database that already contains auth tables.** Before any execution, PM must approve the exact development target and a separately reviewed baseline/adoption strategy after authorized inspection of its existing tables, constraints, grants, data, and migration history. Do not reset the database, drop tables, use `IF NOT EXISTS` to conceal drift, or mark this migration applied without verifying equivalent schema. Production needs separate approval, backup, and recovery planning.

## SQL review

- Seven `CREATE TABLE`, five explicit indexes, and five added FKs. No drops, data rewrites, seeds, RLS policies, grants, extensions, or triggers.
- All tables are created before foreign keys are added; alphabetical creation of children before parents is therefore safe.
- New IDs are UUIDs with `gen_random_uuid()` defaults, following the domain technical design. Existing Better Auth IDs remain text.
- New audit timestamps use `timestamp with time zone DEFAULT now() NOT NULL`, as specified by the domain design. Auth timestamps are untouched.
- Project owner, note project, and revision note FKs use `ON DELETE RESTRICT` (updates default to `NO ACTION`). This also prevents deleting a user who still owns projects. Auth's existing session/account cascades remain unchanged.
- Names and titles require a non-whitespace character. Original content is stored as non-null text without transformation; no minimum content length is imposed in this schema phase.
- `note_date` is nullable SQL `date` without a default and maps to a date string, independent of timezone and insertion time.
- `(owner_id, updated_at)` and `(project_id, updated_at)` support owner/project-scoped lists ordered by last modification, ascending or descending. Add an ID tie-breaker in queries for deterministic results. Event-date indexing is deferred until real query requirements justify it.
- Unique `(note_id, version)` supports ordered per-note history and FK lookups; there is no redundant standalone note-ID index. Versions must be positive integers.
- `$onUpdate` is a Drizzle runtime hook, **not a database trigger**. The future backend must explicitly manage atomic updates; raw SQL does not automatically advance `updated_at`.

## Revision semantics for Phase 1D

1. Creating a note writes only its current state to `notes`: logical version **1**, no snapshot.
2. A meaningful change to title, content, or note date archives the outgoing values with their outgoing version number. On the first edit, snapshot version 1 is inserted and the current note becomes version 2.
3. Lock the note row, determine `max(version) + 1` (or 1 when no snapshots exist), insert the outgoing snapshot, and update the current note in **one transaction**. Concurrent writers must use the same lock protocol; the unique constraint is a final duplicate guard, not an edit service.
4. No-op saves do not allocate a revision. Snapshots are append-only by backend convention. No services, immutability triggers, gap prevention, or deletion operations are implemented here.
5. Order history by `version`, not timestamps. Revision `created_at` records archival time. Snapshot title/content/note_date plus the stable parent note reconstruct the historical content and event date; it is not a separate record of every previous `updated_at` value.

## Security / execution gate

Ownership columns and foreign keys are **not authorization**. Phase 1D must verify server sessions and ownership on every read/write. No RLS policies or Supabase Auth integration are introduced.

**Supabase Data API exposure must be reviewed before migration execution.** These tables use the existing `public` schema. Depending on project defaults, new tables can receive `anon` / `authenticated` grants and become reachable through the Data API without the application's ownership checks. Confirm the Data API is disabled or these tables are not exposed / granted to public roles, or obtain approval for an appropriate RLS/schema-access design before applying. Do not assume Better Auth's user IDs correspond to Supabase Auth `auth.uid()`.

References inspected: [Securing your Data API](https://supabase.com/docs/guides/api/securing-your-api), [Supabase changelog](https://supabase.com/changelog.md).

No database connection, schema execution, migration application, or provisioning is part of this phase. Offline metadata/query-compilation tests do not prove PostgreSQL constraint enforcement. Integration checks against an approved disposable development target remain required before accepting migration execution.

## Phase 2B chat migration review — historical offline review

Generated with the unchanged Drizzle ORM / Kit **1.0.0-rc.5** workflow:

```sh
bun run db:generate --name chat_persistence
```

Artifacts: `20261118093854_chat_persistence/{migration.sql,snapshot.json}`. Generation compares local definitions with the previous local snapshot. It does not connect to PostgreSQL or establish that a remote schema matches that snapshot.

### SQL and compatibility review

- Exactly two new tables: `chat_conversations` and `chat_messages`; no existing table definition is modified. No data mutations, enums, extensions, triggers, grants, or RLS changes.
- Conversations have database-generated UUID primary keys, required text owner IDs referencing the existing Better Auth `user.id`, nullable project UUIDs referencing `projects.id`, required nonblank titles and required timezone-aware audit timestamps. Null project is global scope.
- Messages have database-generated UUID primary keys, required conversation/turn UUIDs, required text role/content/status, nullable model ID and required timezone-aware audit timestamps. CHECK constraints restrict roles to user/assistant and statuses to pending/completed/failed/stopped. User messages must be completed and have no model ID; assistants can use the four statuses.
- All three new FKs use `ON DELETE RESTRICT`. A project/user with retained conversations, or a conversation with retained messages, cannot be deleted. No delete API is introduced. Updates default to NO ACTION.
- Unique `(conversation_id, turn_id, role)` prevents duplicate roles within a turn. The partial unique index on `(conversation_id) WHERE status = 'pending'` independently enforces at most one pending assistant per conversation. Pair creation and immutable scope/terminal states are enforced by the server service, not by additional tables or triggers.
- Owner history index `(owner_id, updated_at DESC, id DESC)` matches recent-activity listing and its stable tie-breaker. Ordered-message index `(conversation_id, created_at, role DESC, id)` supports bounded chronological pages; role DESC puts user before assistant at the pair's shared timestamp. Both role/status columns are text with CHECKs, not PostgreSQL enums.
- The migration adds all tables before their FK statements. Existing auth/project/note/revision definitions and the Phase 1 migration artifacts remain unchanged. Verify the actual target has the approved Phase 1 schema and an approved baseline/migration history; the earlier initial-auth baseline warning still applies. Do not blindly run the full migration chain against an existing database.

### Minimum protection proposal — requires PM approval before execution

The new tables are in `public`, following the current architecture. Foreign keys and server owner predicates do **not** protect direct Supabase REST/GraphQL access. Better Auth uses its own text user IDs and sessions, not Supabase Auth JWTs; an `auth.uid()` policy would not implement this ownership model.

The minimum architecture-compatible boundary is **no Data API access to these backend-only tables**. Before applying, independently inspect the exact development target's exposed schemas, automatically exposed table settings, default privileges, effective PUBLIC/anon/authenticated privileges, and backend database role. If the application does not use the Data API, PM can approve disabling it. If it must remain enabled, obtain approval for table-specific revocation of all privileges from PUBLIC/anon/authenticated, retaining only necessary backend-role access, and RLS enabled with no public allow policies as defense in depth. Verify backend access remains compatible: a non-owner/non-bypass backend role needs a separately reviewed backend-role policy, not a fabricated Supabase user mapping. Do not add public grants or default-privilege changes speculatively.

**None of these permission/RLS/infrastructure changes are included or applied here.** The generated table-only migration must not be executed until PM approves the chosen exposure protections and how they will be applied atomically with table creation (or verifies Data API is already disabled). Also review inherited privileges and GraphQL/Realtime exposure as applicable. Do not rely on current platform defaults; they vary by project age and settings.

References reviewed: [Supabase changelog](https://supabase.com/changelog.md) and [Securing your API](https://supabase.com/docs/guides/api/securing-your-api). No Supabase client, CLI, or extension upgrade is part of this work.

### Remaining execution gate

PM must approve the exact non-production target, Phase 1 baseline compatibility, exposure/grant/RLS plan, this SQL, and the ten-minute pending-turn recovery policy before rollout. Review backup/recovery and a disposable-development integration plan covering FK/CHECK/unique enforcement, real simultaneous turn requests, rollback, and interrupted/ambiguous commits. No migration, SQL execution, provisioning, or database connection was performed for Phase 2B.

## P3.1 note proposal migration review — development access verified in P3.2

`bun run db:generate --name note_proposals` generated `20261119144819_note_proposals/{migration.sql,snapshot.json}` offline using the unchanged config/Kit workflow. The v9 diff extends the chat snapshot and creates only `note_proposals`: 14 columns, PK, source-message UNIQUE, three CHECKs and three RESTRICT FKs. No standalone index, existing-table modification, data write, permission change or migration execution is included. Both previous migrations remain untouched.

See [the proposal schema and application contract](../../../../docs/NOTE_PROPOSALS.md) for exact columns, derived source/owner mapping, receipt invariants, implemented atomic chat/proposal/preview behaviour and P3.3 confirmation. P3.2 adds runtime tool/SSE/UI/service changes without changing this SQL or applying migrations. PM's current Data API-disabled confirmation is accepted; backend access was checked read-only as recorded above. The generated `public` table has no RLS policy; any future API exposure or permission change requires a separately approved access design. Never map Better Auth users to Supabase Auth `auth.uid()`. Real PostgreSQL write/constraint/concurrency verification remains distinct from these access checks and offline tests.
