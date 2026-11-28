import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { createDb } from "./index";
import { tasks, projects, notes, authRelations } from "./schema";
import { relations } from "./relations";

const config = getTableConfig(tasks);
const dialect = new PgDialect();
const migrationRoot = "./migrations/20261128012406_project_tasks/";

test("task metadata uses existing UUIDs, nullable date/text fields, timestamps and restrictive parents", () => {
  assert.equal(tasks.id.primary, true);
  assert.equal(tasks.id.getSQLType(), "uuid");
  assert.equal(tasks.id.hasDefault, true);
  assert.deepEqual(
    config.columns.map((column) => column.name),
    [
      "id",
      "project_id",
      "title",
      "description",
      "status",
      "priority",
      "assignee",
      "due_date",
      "source_note_id",
      "version",
      "created_at",
      "updated_at",
      "completed_at",
    ],
  );
  for (const column of [
    tasks.projectId,
    tasks.title,
    tasks.status,
    tasks.version,
    tasks.createdAt,
    tasks.updatedAt,
  ])
    assert.equal(column.notNull, true);
  for (const column of [
    tasks.description,
    tasks.priority,
    tasks.assignee,
    tasks.dueDate,
    tasks.sourceNoteId,
    tasks.completedAt,
  ]) {
    assert.equal(column.notNull, false);
    assert.equal(column.hasDefault, false);
  }
  assert.equal(tasks.status.default, "todo");
  assert.equal(tasks.version.default, 1);
  assert.equal(tasks.dueDate.getSQLType(), "date");
  assert.equal(tasks.dueDate.dataType, "string date");
  for (const column of [tasks.createdAt, tasks.updatedAt, tasks.completedAt])
    assert.equal(column.getSQLType(), "timestamp with time zone");
  assert.equal(typeof tasks.updatedAt.onUpdateFn, "function");
  assert.deepEqual(
    config.foreignKeys.map((fk) => [fk.reference().columns[0], fk.reference().foreignTable]),
    [
      [tasks.projectId, projects],
      [tasks.sourceNoteId, notes],
    ],
  );
  for (const fk of config.foreignKeys) {
    assert.equal(fk.onDelete, "restrict");
    assert.equal(fk.onUpdate, "no action");
  }
});

test("task CHECKs constrain title/text lengths, enum values, version and both completion states", () => {
  assert.equal(config.checks.length, 8);
  const check = (name: string) =>
    dialect.sqlToQuery(config.checks.find((c) => c.name === name)!.value).sql;
  assert.match(check("tasks_title_nonblank"), /\[\^\[:space:\]\]/);
  assert.match(check("tasks_title_length"), /char_length\("tasks"\."title"\) <= 300/);
  assert.match(check("tasks_description_length"), /<= 5000/);
  assert.match(check("tasks_assignee_length"), /<= 200/);
  assert.match(check("tasks_status_valid"), /'todo', 'in_progress', 'blocked', 'done'/);
  assert.match(check("tasks_priority_valid"), /'urgent', 'high', 'medium', 'low'/);
  assert.match(check("tasks_version_positive"), /> 0/);
  assert.match(
    check("tasks_completed_consistent"),
    /"status" = 'done' and "tasks"\."completed_at" is not null/,
  );
  assert.match(
    check("tasks_completed_consistent"),
    /"status" <> 'done' and "tasks"\."completed_at" is null/,
  );
  assert.deepEqual(
    config.indexes.map((i) => [
      i.config.name,
      i.config.columns.map((c) => ("name" in c ? c.name : null)),
    ]),
    [
      ["tasks_project_updated_idx", ["project_id", "updated_at", "id"]],
      ["tasks_project_due_idx", ["project_id", "due_date", "id"]],
    ],
  );
});

test("task, project and optional source relations compile offline without replacing auth relations", () => {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const deny = () => {
    throw new Error("No network in task schema tests");
  };
  db.$client.query = deny;
  db.$client.connect = deny;
  assert.equal(relations.user.relations.sessions, authRelations.user.relations.sessions);
  const query = db.query.tasks
    .findMany({
      with: { project: { with: { owner: true } }, sourceNote: { with: { revisions: true } } },
    })
    .toSQL().sql;
  for (const table of ["tasks", "projects", "notes", "note_revisions", "user"])
    assert.ok(query.includes(`"${table}"`));
  assert.ok(
    db.query.projects
      .findMany({ with: { tasks: true } })
      .toSQL()
      .sql.includes('"tasks"'),
  );
  assert.ok(
    db.query.notes
      .findMany({ with: { tasks: true } })
      .toSQL()
      .sql.includes('"tasks"'),
  );
});

test("generated task migration and v9 diff snapshot create only the approved new table footprint", () => {
  const sql = readFileSync(new URL(`${migrationRoot}migration.sql`, import.meta.url), "utf8");
  assert.doesNotMatch(
    sql,
    /^\s*(DROP|TRUNCATE|DELETE|UPDATE|INSERT|GRANT|REVOKE|CREATE POLICY|CREATE TRIGGER|CREATE EXTENSION)\b/im,
  );
  assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, 1);
  assert.equal((sql.match(/CREATE INDEX/g) ?? []).length, 2);
  assert.equal((sql.match(/ALTER TABLE "tasks" ADD CONSTRAINT/g) ?? []).length, 2);
  assert.equal((sql.match(/ON DELETE RESTRICT/g) ?? []).length, 2);
  assert.equal((sql.match(/CHECK \(/g) ?? []).length, 8);
  assert.match(sql, /"due_date" date/);
  assert.match(sql, /"version" integer DEFAULT 1 NOT NULL/);
  assert.match(sql, /"status" text DEFAULT 'todo' NOT NULL/);
  assert.doesNotMatch(sql, /ALTER TABLE "(?!tasks")/);
  const snapshot = JSON.parse(
    readFileSync(new URL(`${migrationRoot}snapshot.json`, import.meta.url), "utf8"),
  );
  const previous = JSON.parse(
    readFileSync(
      new URL("./migrations/20261120105833_chat_source_refs/snapshot.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(snapshot.version, "9");
  assert.deepEqual(snapshot.prevIds, [previous.id]);
  assert.equal(snapshot.deltas.length, 27);
  for (const delta of snapshot.deltas) {
    assert.equal(delta.op, "create");
    assert.equal(delta.row.schema, "public");
    assert.equal(delta.row.table ?? delta.row.name, "tasks");
  }
  assert.deepEqual(
    snapshot.footprints.map((f: { statementType: string }) => f.statementType),
    ["create_table", "create_index", "create_index", "create_fk", "create_fk"],
  );
  for (const footprint of snapshot.footprints)
    for (const write of footprint.writes) assert.match(write, /public\.tasks(?:[._]|$)/);
});
