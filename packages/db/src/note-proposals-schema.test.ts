import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { and, eq } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

import { createDb } from "./index";
import { relations } from "./relations";
import {
  authRelations,
  chatConversations,
  chatMessages,
  noteProposals,
  notes,
  projects,
} from "./schema";

const dialect = new PgDialect();
const config = getTableConfig(noteProposals);
const root = new URL("./migrations/", import.meta.url);
const directories = readdirSync(root).filter((name) => name.endsWith("_note_proposals"));
assert.equal(directories.length, 1);
const migrationRoot = new URL(`${directories[0]}/`, root);
const migration = readFileSync(new URL("migration.sql", migrationRoot), "utf8");
const snapshot = JSON.parse(readFileSync(new URL("snapshot.json", migrationRoot), "utf8"));

test("proposals store only original draft, source identity and confirmation receipt", () => {
  assert.deepEqual(
    config.columns.map((c) => c.name),
    [
      "id",
      "source_message_id",
      "project_hint",
      "title",
      "content",
      "note_date",
      "status",
      "note_id",
      "approved_project_id",
      "approved_title",
      "approved_content",
      "approved_note_date",
      "created_at",
      "confirmed_at",
    ],
  );
  assert.equal(noteProposals.id.getSQLType(), "uuid");
  assert.equal(noteProposals.id.primary, true);
  assert.equal(noteProposals.id.hasDefault, true);
  for (const column of [
    noteProposals.sourceMessageId,
    noteProposals.title,
    noteProposals.content,
    noteProposals.status,
  ])
    assert.equal(column.notNull, true);
  assert.equal(noteProposals.status.default, "proposed");
  for (const column of [noteProposals.noteDate, noteProposals.approvedNoteDate]) {
    assert.equal(column.getSQLType(), "date");
    assert.equal(column.notNull, false);
    assert.equal(column.hasDefault, false);
  }
  assert.equal(noteProposals.createdAt.getSQLType(), "timestamp with time zone");
  assert.equal(noteProposals.createdAt.notNull, true);
  assert.equal(noteProposals.createdAt.hasDefault, true);
  assert.equal(noteProposals.confirmedAt.getSQLType(), "timestamp with time zone");
  for (const column of [
    noteProposals.projectHint,
    noteProposals.noteId,
    noteProposals.approvedProjectId,
    noteProposals.approvedTitle,
    noteProposals.approvedContent,
    noteProposals.confirmedAt,
  ]) {
    assert.equal(column.notNull, false);
    assert.equal(column.hasDefault, false);
  }
  for (const column of config.columns) assert.equal(column.onUpdateFn, undefined);
});

test("unique source plus existing turn-role uniqueness identifies one accepted assistant proposal per turn", () => {
  assert.deepEqual(
    config.uniqueConstraints.map((c) => c.columns.map((column) => column.name)),
    [["source_message_id"]],
  );
  assert.deepEqual(
    getTableConfig(chatMessages).uniqueConstraints.map((c) =>
      c.columns.map((column) => column.name),
    ),
    [["conversation_id", "turn_id", "role"]],
  );
  // Source assistant/completed validation belongs to the future service. A FK
  // alone does not exclude user messages or enforce ownership/terminal state.
  assert.equal(config.indexes.length, 0); // PK + source UNIQUE cover planned lookups.
  assert.equal(config.foreignKeys.length, 3);
  assert.deepEqual(
    config.foreignKeys.map((fk) => [fk.reference().columns[0], fk.reference().foreignTable]),
    [
      [noteProposals.sourceMessageId, chatMessages],
      [noteProposals.noteId, notes],
      [noteProposals.approvedProjectId, projects],
    ],
  );
  for (const fk of config.foreignKeys) {
    assert.equal(fk.onDelete, "restrict");
    assert.equal(fk.onUpdate, "no action");
    assert.deepEqual(
      fk.reference().foreignColumns.map((c) => c.name),
      ["id"],
    );
  }
});

test("receipt CHECK permits only proposed without receipt or confirmed with complete receipt", () => {
  assert.equal(config.checks.length, 3);
  const receipt = dialect.sqlToQuery(
    config.checks.find((c) => c.name === "note_proposals_receipt_consistent")!.value,
  ).sql;
  const [proposed, confirmed] = receipt.split(") or (");
  assert.match(proposed!, /"status" = 'proposed'/);
  assert.match(confirmed!, /"status" = 'confirmed'/);
  for (const column of [
    "note_id",
    "approved_project_id",
    "approved_title",
    "approved_content",
    "approved_note_date",
    "confirmed_at",
  ])
    assert.ok(proposed!.includes(`"${column}" is null`));
  for (const column of [
    "note_id",
    "approved_project_id",
    "approved_title",
    "approved_content",
    "confirmed_at",
  ])
    assert.ok(confirmed!.includes(`"${column}" is not null`));
  assert.ok(!confirmed!.includes('"approved_note_date" is not null'));
  assert.doesNotMatch(receipt, /cancelled|expired|pending/);
  const nonblank = config.checks
    .filter((c) => c.name !== "note_proposals_receipt_consistent")
    .map((c) => dialect.sqlToQuery(c.value).sql)
    .join(" ");
  for (const column of ["title", "content", "approved_title", "approved_content"])
    assert.ok(nonblank.includes(`"${column}" ~ '[^[:space:]]'`));
});

function offlineDb() {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const deny = () => {
    throw new Error("No database access in proposal schema tests");
  };
  db.$client.query = deny;
  db.$client.connect = deny;
  return db;
}

test("proposal/source and history relations compile without changing auth relationships", () => {
  const db = offlineDb();
  assert.equal(relations.user.relations.sessions, authRelations.user.relations.sessions);
  assert.equal(relations.user.relations.accounts, authRelations.user.relations.accounts);
  const history = db.query.chatMessages.findMany({ with: { proposal: true } }).toSQL().sql;
  const receipt = db.query.noteProposals
    .findMany({
      with: {
        sourceMessage: { with: { conversation: { with: { owner: true, project: true } } } },
        approvedProject: true,
        note: true,
      },
    })
    .toSQL().sql;
  for (const table of ["chat_messages", "note_proposals"])
    assert.ok(history.includes(`"${table}"`));
  for (const table of [
    "note_proposals",
    "chat_messages",
    "chat_conversations",
    "user",
    "projects",
    "notes",
  ])
    assert.ok(receipt.includes(`"${table}"`));
});

test("proposed source ownership and proposal-row lock SQL compile with bound parameters", () => {
  // This is a contract SQL compilation check, not an implemented authorization
  // operation. Scoped-project ownership must also be rechecked by that service.
  const db = offlineDb();
  const id = "00000000-0000-4000-8000-000000000001";
  const query = db
    .select({ id: noteProposals.id })
    .from(noteProposals)
    .innerJoin(chatMessages, eq(chatMessages.id, noteProposals.sourceMessageId))
    .innerJoin(chatConversations, eq(chatConversations.id, chatMessages.conversationId))
    .where(
      and(
        eq(noteProposals.id, id),
        eq(chatConversations.ownerId, "session-owner"),
        eq(chatMessages.role, "assistant"),
        eq(chatMessages.status, "completed"),
      ),
    )
    .for("update", { of: noteProposals })
    .toSQL();
  assert.match(query.sql, /"chat_conversations"\."owner_id" = \$\d/);
  assert.match(query.sql, /for update of "note_proposals"/);
  assert.deepEqual(query.params, [id, "session-owner", "assistant", "completed"]);
  assert.ok(!query.sql.includes("session-owner"));
});

test("incremental proposal SQL only creates one table with three restrictive FKs", () => {
  const statements = migration
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  assert.equal(statements.length, 4);
  assert.match(statements[0]!, /^CREATE TABLE "note_proposals"/);
  for (const statement of statements.slice(1))
    assert.match(statement, /^ALTER TABLE "note_proposals" ADD CONSTRAINT .* FOREIGN KEY/);
  assert.equal((migration.match(/FOREIGN KEY/g) ?? []).length, 3);
  assert.equal((migration.match(/ON DELETE RESTRICT/g) ?? []).length, 3);
  assert.equal((migration.match(/CHECK \(/g) ?? []).length, 3);
  assert.match(
    migration,
    /"source_message_id" uuid NOT NULL CONSTRAINT "note_proposals_source_message_unique" UNIQUE/,
  );
  assert.doesNotMatch(
    migration,
    /\b(DROP|TRUNCATE|DELETE FROM|UPDATE|INSERT|GRANT|REVOKE|POLICY|TRIGGER|EXTENSION|CREATE INDEX|CREATE TYPE)\b/i,
  );
  assert.match(migration, /"status" text DEFAULT 'proposed' NOT NULL/);
  assert.match(migration, /"note_date" date,/);
  assert.match(migration, /"approved_note_date" date,/);
});

test("v9 diff snapshot extends chat history with only matching new proposal definitions", () => {
  const baseline = JSON.parse(
    readFileSync(new URL("20261118093854_chat_persistence/snapshot.json", root), "utf8"),
  );
  assert.equal(snapshot.version, "9");
  assert.equal(snapshot.dialect, "postgres");
  assert.equal(snapshot.type, "diff");
  assert.deepEqual(snapshot.prevIds, [baseline.id]);
  for (const footprint of snapshot.footprints) {
    assert.ok(["create_table", "create_fk"].includes(footprint.statementType));
    for (const target of footprint.writes) assert.ok(target.includes("public.note_proposals"));
  }
  for (const delta of snapshot.deltas) {
    assert.equal(delta.op, "create");
    assert.equal(delta.row.schema, "public");
    assert.equal(delta.row.table ?? delta.row.name, "note_proposals");
    if (delta.row.entityType === "tables") assert.equal(delta.row.isRlsEnabled, false);
  }
  const columns = snapshot.deltas
    .filter((d: any) => d.row.entityType === "columns")
    .map((d: any) => d.row);
  assert.deepEqual(
    columns.map((c: any) => c.name),
    config.columns.map((c) => c.name),
  );
  for (const column of config.columns) {
    const stored = columns.find((c: any) => c.name === column.name);
    assert.equal(stored.type, column.getSQLType());
    assert.equal(stored.notNull, column.notNull);
  }
  const checks = snapshot.deltas
    .filter((d: any) => d.row.entityType === "checks")
    .map((d: any) => d.row);
  for (const check of config.checks) {
    const value = dialect.sqlToQuery(check.value).sql.replaceAll('"note_proposals".', "");
    assert.equal(checks.find((c: any) => c.name === check.name).value, value);
    assert.ok(migration.includes(`CONSTRAINT "${check.name}" CHECK (${value})`));
  }
  assert.equal(snapshot.deltas.filter((d: any) => d.row.entityType === "fks").length, 3);
  assert.equal(snapshot.deltas.filter((d: any) => d.row.entityType === "uniques").length, 1);
  assert.equal(snapshot.deltas.filter((d: any) => d.row.entityType === "pks").length, 1);
});
