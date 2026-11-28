import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { createDb } from "./index";
import { managementProposals, chatMessages, authRelations } from "./schema";
import { relations } from "./relations";

const config = getTableConfig(managementProposals);
const migration = new URL("./migrations/20261128060549_management_proposals/", import.meta.url);
test("management schema has exactly eight columns, one restrictive source FK, uniqueness and no result FKs/indexes", () => {
  assert.deepEqual(
    config.columns.map((c) => c.name),
    ["id", "source_message_id", "kind", "draft", "status", "receipt", "created_at", "confirmed_at"],
  );
  assert.equal(managementProposals.id.primary, true);
  assert.equal(managementProposals.id.hasDefault, true);
  assert.equal(managementProposals.status.default, "proposed");
  for (const column of [
    managementProposals.sourceMessageId,
    managementProposals.kind,
    managementProposals.draft,
    managementProposals.status,
    managementProposals.createdAt,
  ])
    assert.equal(column.notNull, true);
  for (const column of [managementProposals.receipt, managementProposals.confirmedAt])
    assert.equal(column.notNull, false);
  assert.equal(config.uniqueConstraints.length, 1);
  assert.deepEqual(
    config.uniqueConstraints[0]!.columns.map((c) => c.name),
    ["source_message_id"],
  );
  assert.equal(config.indexes.length, 0);
  assert.equal(config.foreignKeys.length, 1);
  assert.equal(config.foreignKeys[0]!.reference().foreignTable, chatMessages);
  assert.equal(config.foreignKeys[0]!.onDelete, "restrict");
  assert.equal(config.foreignKeys[0]!.onUpdate, "no action");
  assert.equal(managementProposals.createdAt.getSQLType(), "timestamp with time zone");
  assert.equal(managementProposals.draft.getSQLType(), "jsonb");
});
test("five approved CHECKs fail closed for missing JSON envelope keys and constrain lifecycle/size", () => {
  assert.equal(config.checks.length, 5);
  const dialect = new PgDialect();
  const sql = config.checks.map((c) => dialect.sqlToQuery(c.value).sql).join("\n");
  assert.match(sql, /'create_project', 'create_tasks', 'update_task'/);
  assert.match(sql, /'proposed', 'confirmed'/);
  assert.match(sql, /coalesce\(.*->'schemaVersion' = '1'::jsonb, false\)/);
  assert.match(sql, /coalesce\(.*->'kind' = to_jsonb/);
  assert.match(sql, /"receipt" is null and .*"confirmed_at" is null/);
  assert.match(sql, /"receipt" is not null and .*"confirmed_at" is not null/);
  assert.equal((sql.match(/<= 131072/g) ?? []).length, 2);
});
test("management relations compile offline and keep auth/note relations intact", () => {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  db.$client.query = db.$client.connect = (() => {
    throw new Error("No network");
  }) as never;
  assert.equal(relations.user.relations.sessions, authRelations.user.relations.sessions);
  assert.match(
    db.query.managementProposals
      .findMany({ with: { sourceMessage: { with: { conversation: true } } } })
      .toSQL().sql,
    /"chat_conversations"/,
  );
  assert.match(
    db.query.chatMessages.findMany({ with: { proposal: true, managementProposal: true } }).toSQL()
      .sql,
    /"note_proposals"/,
  );
});
test("incremental migration creates only management_proposals with the approved footprint", () => {
  const sql = readFileSync(new URL("migration.sql", migration), "utf8");
  assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, 1);
  assert.equal((sql.match(/ALTER TABLE/g) ?? []).length, 1);
  assert.equal((sql.match(/CHECK \(/g) ?? []).length, 5);
  assert.equal((sql.match(/FOREIGN KEY/g) ?? []).length, 1);
  assert.match(sql, /REFERENCES "chat_messages"\("id"\) ON DELETE RESTRICT/);
  assert.doesNotMatch(
    sql,
    /CREATE INDEX|GRANT|REVOKE|POLICY|TRIGGER|DROP|INSERT|UPDATE |DELETE FROM/,
  );
  assert.doesNotMatch(sql, /ALTER TABLE "(?!management_proposals")/);
  const snapshot = JSON.parse(readFileSync(new URL("snapshot.json", migration), "utf8"));
  const previous = JSON.parse(
    readFileSync(
      new URL("./migrations/20261128012406_project_tasks/snapshot.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(snapshot.version, "9");
  assert.deepEqual(snapshot.prevIds, [previous.id]);
  assert.equal(snapshot.deltas.length, 17);
  for (const delta of snapshot.deltas) {
    assert.equal(delta.op, "create");
    assert.equal(delta.row.schema, "public");
    assert.equal(delta.row.table ?? delta.row.name, "management_proposals");
  }
  assert.deepEqual(
    snapshot.footprints.map((f: { statementType: string }) => f.statementType),
    ["create_table", "create_fk"],
  );
});
