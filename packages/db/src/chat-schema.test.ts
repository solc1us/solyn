import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";

import { createDb } from "./index";
import { authRelations, chatConversations, chatMessages, projects, user } from "./schema";
import { relations } from "./relations";

const dialect = new PgDialect();

test("chat adds exactly the approved columns, UUID keys and text Better Auth ownership", () => {
  assert.deepEqual(
    getTableConfig(chatConversations).columns.map((c) => c.name),
    ["id", "owner_id", "project_id", "title", "created_at", "updated_at"],
  );
  assert.deepEqual(
    getTableConfig(chatMessages).columns.map((c) => c.name),
    [
      "id",
      "conversation_id",
      "turn_id",
      "role",
      "content",
      "status",
      "model_id",
      "source_refs",
      "created_at",
      "updated_at",
    ],
  );
  assert.equal(chatConversations.ownerId.getSQLType(), user.id.getSQLType());
  assert.equal(chatConversations.projectId.notNull, false);
  assert.equal(chatConversations.projectId.hasDefault, false);
  assert.equal(chatMessages.modelId.notNull, false);
  assert.equal(chatMessages.sourceRefs.notNull, false);
  assert.equal(chatMessages.sourceRefs.hasDefault, false);
  assert.equal(chatMessages.sourceRefs.getSQLType(), "jsonb");
  for (const table of [chatConversations, chatMessages]) {
    assert.equal(table.id.getSQLType(), "uuid");
    assert.equal(table.id.primary, true);
    assert.equal(table.id.hasDefault, true);
    for (const column of [table.createdAt, table.updatedAt]) {
      assert.equal(column.getSQLType(), "timestamp with time zone");
      assert.equal(column.notNull, true);
      assert.equal(column.hasDefault, true);
    }
  }
  assert.equal(chatMessages.turnId.getSQLType(), "uuid");
  assert.equal(chatMessages.turnId.notNull, true);
  assert.equal(chatMessages.role.getSQLType(), "text");
  assert.equal(chatMessages.status.getSQLType(), "text");
});

test("chat parent foreign keys restrict deletion and preserve required message links", () => {
  const conversationFks = getTableConfig(chatConversations).foreignKeys;
  assert.equal(conversationFks.length, 2);
  assert.deepEqual(
    conversationFks.map((fk) => fk.reference().foreignTable),
    [user, projects],
  );
  const [messageFk] = getTableConfig(chatMessages).foreignKeys;
  assert.equal(messageFk!.reference().foreignTable, chatConversations);
  for (const fk of [...conversationFks, messageFk!]) assert.equal(fk.onDelete, "restrict");
  for (const column of [
    chatConversations.ownerId,
    chatConversations.title,
    chatMessages.conversationId,
    chatMessages.turnId,
    chatMessages.role,
    chatMessages.content,
    chatMessages.status,
  ])
    assert.equal(column.notNull, true);
});

test("text checks enforce roles, statuses and completed/model-free user messages", () => {
  const config = getTableConfig(chatMessages);
  const checks = config.checks.map((c) => dialect.sqlToQuery(c.value).sql).join(" ");
  assert.match(checks, /"role" in \('user', 'assistant'\)/);
  assert.match(checks, /"status" in \('pending', 'completed', 'failed', 'stopped'\)/);
  assert.match(
    checks,
    /"role" <> 'user' or \("chat_messages"\."status" = 'completed' and "chat_messages"\."model_id" is null\)/,
  );
  assert.deepEqual(
    config.uniqueConstraints.map((c) => c.columns.map((column) => column.name)),
    [["conversation_id", "turn_id", "role"]],
  );
  const pendingIndex = config.indexes.find(
    (i) => i.config.name === "chat_messages_one_pending_idx",
  )!;
  assert.equal(pendingIndex.config.unique, true);
  assert.match(dialect.sqlToQuery(pendingIndex.config.where!).sql, /"status" = 'pending'/);
  assert.equal(config.indexes.length, 2);
  assert.equal(getTableConfig(chatConversations).indexes.length, 1);
});

test("source metadata is bounded and restricted to completed assistants without complex JSON SQL", () => {
  const check = getTableConfig(chatMessages).checks.find(
    (value) => value.name === "chat_messages_sources_consistent",
  )!;
  const sql = dialect.sqlToQuery(check.value).sql;
  assert.match(sql, /case\s+when .*"source_refs" is null then true/);
  assert.match(sql, /jsonb_typeof\(.*"source_refs"\) = 'array' then/);
  assert.match(sql, /"role" = 'assistant' and .*"status" = 'completed'/);
  assert.match(sql, /jsonb_array_length\(.*"source_refs"\) between 1 and 5/);
  assert.match(sql, /else false\s+end/);
});

test("generated sources migration adds only a nullable column and CHECK to the prior snapshot", () => {
  const root = new URL("./migrations/", import.meta.url);
  const directories = readdirSync(root).filter((name) => name.endsWith("_chat_source_refs"));
  assert.equal(directories.length, 1);
  const migration = readFileSync(new URL(`${directories[0]}/migration.sql`, root), "utf8");
  assert.match(migration, /^ALTER TABLE "chat_messages" ADD COLUMN "source_refs" jsonb;/);
  assert.equal((migration.match(/ALTER TABLE/g) ?? []).length, 2);
  assert.equal((migration.match(/ADD CONSTRAINT/g) ?? []).length, 1);
  assert.doesNotMatch(
    migration,
    /\b(DROP|UPDATE|INSERT|DELETE|TRUNCATE|GRANT|REVOKE|INDEX|DEFAULT|NOT NULL)\b/,
  );
  const snapshot = JSON.parse(
    readFileSync(new URL(`${directories[0]}/snapshot.json`, root), "utf8"),
  );
  const previous = JSON.parse(
    readFileSync(new URL("20261119144819_note_proposals/snapshot.json", root), "utf8"),
  );
  assert.deepEqual(snapshot.prevIds, [previous.id]);
  assert.deepEqual(
    snapshot.footprints.map((value: { statementType: string }) => value.statementType),
    ["add_column", "add_check"],
  );
  assert.equal(snapshot.deltas.length, 2);
  for (const delta of snapshot.deltas) {
    assert.equal(delta.op, "create");
    assert.equal(delta.row.table, "chat_messages");
    assert.ok(["source_refs", "chat_messages_sources_consistent"].includes(delta.row.name));
  }
});

test("chat relations compile in both directions while preserving existing auth/workspace relations", () => {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const deny = () => {
    throw new Error("No database access in schema tests");
  };
  db.$client.query = deny;
  db.$client.connect = deny;
  assert.equal(relations.user.relations.sessions, authRelations.user.relations.sessions);
  const forward = db.query.user
    .findMany({ with: { conversations: { with: { messages: true, project: true } } } })
    .toSQL().sql;
  const reverse = db.query.chatMessages
    .findMany({ with: { conversation: { with: { owner: true, project: true } } } })
    .toSQL().sql;
  for (const sql of [forward, reverse]) {
    for (const table of ["chat_conversations", "chat_messages", "user", "projects"])
      assert.ok(sql.includes(`"${table}"`));
  }
});

test("generated chat migration adds only two chat tables, constraints, indexes and three FKs", () => {
  const root = new URL("./migrations/", import.meta.url);
  const directories = readdirSync(root).filter((name) => name.endsWith("_chat_persistence"));
  assert.equal(directories.length, 1);
  const migration = readFileSync(new URL(`${directories[0]}/migration.sql`, root), "utf8");
  assert.equal((migration.match(/CREATE TABLE/g) ?? []).length, 2);
  assert.equal((migration.match(/CREATE (?:UNIQUE )?INDEX/g) ?? []).length, 3);
  assert.equal((migration.match(/ADD CONSTRAINT.*FOREIGN KEY/g) ?? []).length, 3);
  assert.equal((migration.match(/ON DELETE RESTRICT/g) ?? []).length, 3);
  assert.doesNotMatch(
    migration,
    /^\s*(DROP|TRUNCATE|DELETE|UPDATE|INSERT|GRANT|REVOKE|CREATE TYPE|CREATE EXTENSION)\b/im,
  );
  assert.doesNotMatch(
    migration,
    /ALTER TABLE "(user|account|session|verification|projects|notes|note_revisions)"/,
  );
  assert.match(migration, /UNIQUE\("conversation_id","turn_id","role"\)/);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "chat_messages_one_pending_idx".*WHERE "status" = 'pending'/,
  );
  assert.match(migration, /"owner_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST/);
  assert.match(migration, /"conversation_id","created_at","role" DESC NULLS LAST,"id"/);
  const snapshot = JSON.parse(
    readFileSync(new URL(`${directories[0]}/snapshot.json`, root), "utf8"),
  );
  const baseline = JSON.parse(
    readFileSync(new URL("20261117115340_core_workspace/snapshot.json", root), "utf8"),
  );
  assert.equal(snapshot.version, "9");
  assert.deepEqual(snapshot.prevIds, [baseline.id]);
  for (const footprint of snapshot.footprints) {
    assert.ok(["create_table", "create_index", "create_fk"].includes(footprint.statementType));
    for (const target of footprint.writes)
      assert.match(target, /public\.chat_(conversations|messages)/);
  }
});
