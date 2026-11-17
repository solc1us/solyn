import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";

import { createDb } from "./index";
import { relations } from "./relations";
import { authRelations, user, projects, notes, noteRevisions } from "./schema";

const dialect = new PgDialect();

test("domain keys and required parent links use UUIDs except the existing text owner key", () => {
  for (const table of [projects, notes, noteRevisions]) {
    assert.equal(table.id.getSQLType(), "uuid");
    assert.equal(table.id.primary, true);
    assert.equal(table.id.hasDefault, true);
  }
  assert.equal(projects.ownerId.getSQLType(), user.id.getSQLType());
  for (const column of [projects.ownerId, notes.projectId, noteRevisions.noteId]) {
    assert.equal(column.notNull, true);
  }
  for (const [table, parent, column] of [
    [projects, user, projects.ownerId],
    [notes, projects, notes.projectId],
    [noteRevisions, notes, noteRevisions.noteId],
  ] as const) {
    const [fk] = getTableConfig(table).foreignKeys;
    assert.ok(fk);
    assert.equal(fk.onDelete, "restrict");
    assert.equal(fk.reference().foreignTable, parent);
    assert.deepEqual(fk.reference().columns, [column]);
  }
});

test("event dates remain nullable and independent from timestamp defaults", () => {
  for (const column of [notes.noteDate, noteRevisions.noteDate]) {
    assert.equal(column.getSQLType(), "date");
    assert.equal(column.notNull, false);
    assert.equal(column.hasDefault, false);
  }
  for (const column of [
    projects.createdAt,
    projects.updatedAt,
    notes.createdAt,
    notes.updatedAt,
    noteRevisions.createdAt,
  ]) {
    assert.equal(column.getSQLType(), "timestamp with time zone");
    assert.equal(column.notNull, true);
    assert.equal(column.hasDefault, true);
  }
  assert.equal(typeof notes.updatedAt.onUpdateFn, "function");
  assert.equal(typeof projects.updatedAt.onUpdateFn, "function");
  assert.equal(notes.createdAt.onUpdateFn, undefined);
  assert.equal(noteRevisions.createdAt.onUpdateFn, undefined);
  assert.equal(projects.description.notNull, false);
});

test("snapshots preserve content and have positive, per-note unique version numbers", () => {
  const config = getTableConfig(noteRevisions);
  assert.deepEqual(
    config.uniqueConstraints.map((c) => c.columns.map((column) => column.name)),
    [["note_id", "version"]],
  );
  assert.equal(noteRevisions.version.notNull, true);
  for (const table of [notes, noteRevisions]) {
    assert.equal(table.title.notNull, true);
    assert.equal(table.content.notNull, true);
  }
  assert.match(
    dialect.sqlToQuery(
      config.checks.find((c) => c.name === "note_revisions_version_positive")!.value,
    ).sql,
    /> 0/,
  );
  for (const table of [projects, notes, noteRevisions]) {
    const checks = getTableConfig(table)
      .checks.map((c) => dialect.sqlToQuery(c.value).sql)
      .join(" ");
    assert.match(checks, /\[\^\[:space:\]\]/);
  }
  assert.deepEqual(
    getTableConfig(projects).indexes.map((i) => i.config.name),
    ["projects_owner_updated_idx"],
  );
  assert.deepEqual(
    getTableConfig(notes).indexes.map((i) => i.config.name),
    ["notes_project_updated_idx"],
  );
  assert.equal(config.indexes.length, 0); // The unique constraint already indexes note_id + version.
});

test("relations compile in both directions and retain Better Auth relations without database access", () => {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const denyDatabase = () => {
    throw new Error("Database access is forbidden in schema tests");
  };
  db.$client.query = denyDatabase;
  db.$client.connect = denyDatabase;
  assert.equal(relations.user.relations.sessions, authRelations.user.relations.sessions);
  assert.equal(relations.user.relations.accounts, authRelations.user.relations.accounts);
  assert.equal(relations.session, authRelations.session);
  assert.equal(relations.account, authRelations.account);
  const forward = db.query.user
    .findMany({
      with: {
        sessions: true,
        accounts: true,
        projects: { with: { notes: { with: { revisions: true } } } },
      },
    })
    .toSQL().sql;
  const reverse = db.query.noteRevisions
    .findMany({ with: { note: { with: { project: { with: { owner: true } } } } } })
    .toSQL().sql;
  for (const table of ["user", "projects", "notes", "note_revisions"]) {
    assert.ok(forward.includes(`"${table}"`));
    assert.ok(reverse.includes(`"${table}"`));
  }
});

test("generated initial migration is additive and applies FKs after all tables exist", () => {
  const sql = readFileSync(
    new URL("./migrations/20261117115340_core_workspace/migration.sql", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(sql, /^\s*(DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/im);
  assert.equal((sql.match(/CREATE TABLE/g) ?? []).length, 7);
  assert.equal((sql.match(/ON DELETE RESTRICT/g) ?? []).length, 3);
  assert.ok(sql.indexOf("ALTER TABLE") > sql.lastIndexOf("CREATE TABLE"));
  assert.match(sql, /UNIQUE\("note_id","version"\)/);
  assert.match(sql, /"note_date" date,/);
  assert.match(sql, /"updated_at" timestamp with time zone DEFAULT now\(\) NOT NULL/);
});
