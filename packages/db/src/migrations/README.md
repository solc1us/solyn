# Phase 1C migration review — NOT APPLIED

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
