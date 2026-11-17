import assert from "node:assert/strict";
import { test } from "node:test";

import { createDb } from "@solyn/db";

import * as contracts from "./contracts";
import { createWorkspaceService } from "./service";

const projectId = "11111111-1111-4111-8111-111111111111";
const noteId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-01-01T00:00:00.000Z");
const content = "  Original\ntext  ";
const noteRow = [noteId, projectId, "Title", content, null, now, now];
const projectRow = [projectId, "Project", null, now, now];
type Step = {
  sql: RegExp;
  rows?: unknown[][];
  inspect?: (sql: string, params: unknown[]) => void;
  error?: Error;
};

// A scripted, non-network driver under the REAL Drizzle query builder. This
// verifies SQL scope and control flow, not PostgreSQL locking or persistence.
function fixture(steps: Step[] = [], userId: string | null = "user-a") {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const remaining = [...steps];
  const calls: string[] = [];
  const query = async (config: { text: string }, params: unknown[] = []) => {
    calls.push(config.text);
    const step = remaining.shift();
    assert.ok(step, `Unexpected SQL: ${config.text}`);
    assert.match(config.text, step.sql);
    step.inspect?.(config.text, params);
    if (step.error) throw step.error;
    return { rows: step.rows ?? [], rowCount: step.rows?.length ?? 0 };
  };
  db.$client.query = query as typeof db.$client.query;
  const client = { query, on() {}, off() {}, release() {} };
  db.$client.connect = (async () => client) as unknown as typeof db.$client.connect;
  let sessionCalls = 0;
  const service = createWorkspaceService({
    db,
    getSession: async () => {
      sessionCalls++;
      return userId ? { user: { id: userId } } : null;
    },
  });
  return { service, calls, remaining, sessionCalls: () => sessionCalls };
}
function scoped(sql: string, params: unknown[]) {
  assert.match(sql, /"owner_id" = \$/);
  assert.ok(params.includes("user-a"));
  assert.ok(params.includes(projectId));
}
function noteScoped(sql: string, params: unknown[]) {
  scoped(sql, params);
  assert.match(sql, /exists \(select/);
  assert.match(sql, /"notes"\."project_id" = \$/);
  assert.match(sql, /"notes"\."id" = \$/);
  assert.ok(params.includes(noteId));
}
function failure(result: { ok: boolean; error?: { code: string } }, code: string) {
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, code);
}
const begin: Step = { sql: /^begin/ };
const commit: Step = { sql: /^commit/ };
const rollback: Step = { sql: /^rollback/ };
const lockNote: Step = {
  sql: /select .*from "notes".*for update of "notes"$/,
  rows: [noteRow],
  inspect: noteScoped,
};
const history = (lastVersion: number | null): Step => ({
  sql: /select max\("version"\) from "note_revisions"/,
  rows: [[lastVersion]],
});

const validCalls = (service: ReturnType<typeof createWorkspaceService>) => [
  () => service.listProjects(),
  () => service.getProject({ projectId }),
  () => service.createProject({ name: "Project" }),
  () => service.updateProject({ projectId, name: "Changed" }),
  () => service.listNotes({ projectId }),
  () => service.getNote({ projectId, noteId }),
  () => service.createNote({ projectId, title: "Title", content }),
  () => service.updateNote({ projectId, noteId, expectedVersion: 1, content: "Changed" }),
];

test("every domain operation denies unauthenticated callers before any SQL", async () => {
  const f = fixture([], null);
  for (const call of validCalls(f.service)) failure(await call(), "UNAUTHENTICATED");
  assert.equal(f.calls.length, 0);
  assert.equal(f.sessionCalls(), 8);
});

test("strict contracts reject UUIDs, blank/oversize fields, unknown update fields and impossible dates", () => {
  for (const name of ["", " \n\t", "x".repeat(201)])
    assert.equal(contracts.createProjectInput.safeParse({ name }).success, false);
  for (const title of ["", " \n", "x".repeat(301)])
    assert.equal(contracts.createNoteInput.safeParse({ projectId, title, content }).success, false);
  for (const value of ["", "  \n", "x".repeat(100_001)])
    assert.equal(
      contracts.createNoteInput.safeParse({ projectId, title: "T", content: value }).success,
      false,
    );
  for (const date of [
    "2025-02-29",
    "2024-02-30",
    "2024-04-31",
    "0000-01-01",
    "2024-13-01",
    "2024-01-00",
    "2024-1-1",
    "2024-01-01T00:00:00Z",
    "",
  ]) {
    assert.equal(
      contracts.createNoteInput.safeParse({ projectId, title: "T", content, noteDate: date })
        .success,
      false,
      date,
    );
  }
  assert.equal(
    contracts.createNoteInput.safeParse({ projectId, title: "T", content, noteDate: "2024-02-29" })
      .success,
    true,
  );
  assert.equal(
    contracts.createNoteInput.safeParse({ projectId, title: "T", content, noteDate: null }).success,
    true,
  );
  assert.equal(
    contracts.createProjectInput.safeParse({ name: "T", description: "x".repeat(5_001) }).success,
    false,
  );
  assert.equal(contracts.projectInput.safeParse({ projectId: "not-a-uuid" }).success, false);
  assert.equal(contracts.noteInput.safeParse({ projectId, noteId: "invalid" }).success, false);
  for (const extra of [
    { ownerId: "user-b" },
    { id: noteId },
    { updatedAt: now },
    { projectId: otherProjectId },
  ]) {
    assert.equal(contracts.createProjectInput.safeParse({ name: "T", ...extra }).success, false);
  }
  assert.equal(
    contracts.updateNoteInput.safeParse({
      projectId,
      noteId,
      expectedVersion: 1,
      content,
      ownerId: "user-b",
    }).success,
    false,
  );
  assert.equal(contracts.updateNoteInput.safeParse({ projectId, noteId, content }).success, false);
  assert.equal(
    contracts.updateNoteInput.safeParse({ projectId, noteId, expectedVersion: 0, content }).success,
    false,
  );
  assert.equal(
    contracts.updateNoteInput.safeParse({ projectId, noteId, expectedVersion: 1 }).success,
    false,
  );
  assert.equal(contracts.updateProjectInput.safeParse({ projectId }).success, false);
  assert.equal(contracts.listProjectsInput.safeParse({ limit: 101 }).success, false);
  assert.equal(contracts.listNotesInput.safeParse({ projectId, offset: -1 }).success, false);
  assert.equal(
    contracts.createNoteInput.parse({ projectId, title: " T ", content }).content,
    content,
  );
});

test("invalid inputs return safe errors without querying or mass assignment", async () => {
  const f = fixture();
  const calls = [
    () => f.service.getProject({ projectId: "invalid" }),
    () => f.service.getNote({ projectId, noteId: "invalid" }),
    () => f.service.createProject({ name: "T", ownerId: "user-b" }),
    () => f.service.updateProject({ projectId, ownerId: "user-b", name: "X" }),
    () =>
      f.service.updateNote({
        projectId,
        noteId,
        expectedVersion: 1,
        content,
        newProjectId: otherProjectId,
      }),
    () => f.service.createNote({ projectId, title: "T", content, noteDate: "2025-02-29" }),
  ];
  for (const call of calls) failure(await call(), "INVALID_INPUT");
  assert.equal(f.calls.length, 0);
});

test("foreign or missing projects are indistinguishable on reads/updates and cannot receive notes", async () => {
  const update = fixture([{ sql: /^update "projects"/, inspect: scoped }]);
  failure(await update.service.updateProject({ projectId, name: "Changed" }), "NOT_FOUND");
  assert.equal(update.remaining.length, 0);
  const f = fixture([
    begin,
    { sql: /select .*from "projects".*for share$/, inspect: scoped },
    rollback,
  ]);
  failure(await f.service.createNote({ projectId, title: "T", content }), "NOT_FOUND");
  assert.equal(f.remaining.length, 0);
  assert.ok(!f.calls.some((sql) => sql.startsWith("insert")));
});

test("foreign project reads and note reads/updates are ownership scoped and return NOT_FOUND", async () => {
  const project = fixture([{ sql: /^select/, inspect: scoped }]);
  failure(await project.service.getProject({ projectId }), "NOT_FOUND");
  const list = fixture([{ sql: /^select/, inspect: scoped }]);
  failure(await list.service.listNotes({ projectId }), "NOT_FOUND");
  const read = fixture([{ sql: /^select/, inspect: noteScoped }]);
  failure(await read.service.getNote({ projectId, noteId }), "NOT_FOUND");
  const update = fixture([begin, { ...lockNote, rows: [] }, rollback]);
  failure(
    await update.service.updateNote({ projectId, noteId, expectedVersion: 1, content: "changed" }),
    "NOT_FOUND",
  );
  assert.ok(!update.calls.some((sql) => /^(insert|update) /.test(sql)));
});

test("project CRUD derives owner from session, scopes updates, and lists deterministically", async () => {
  const f = fixture([
    {
      sql: /^insert into "projects"/,
      rows: [projectRow],
      inspect: (_, params) => {
        assert.ok(params.includes("user-a"));
        assert.ok(params.includes("Project"));
      },
    },
    { sql: /^select/, rows: [projectRow], inspect: scoped },
    {
      sql: /^update "projects"/,
      rows: [projectRow],
      inspect: (sql, params) => {
        scoped(sql, params);
        assert.doesNotMatch(sql.split(" where ")[0]!, /"owner_id" =/);
      },
    },
    {
      sql: /^select .*order by "projects"\."updated_at" desc, "projects"\."id" desc limit \$\d+ offset \$\d+$/,
      rows: [projectRow],
      inspect: (sql, params) => {
        assert.match(sql, /"owner_id" =/);
        assert.deepEqual(params, ["user-a", 10, 5]);
      },
    },
  ]);
  const created = await f.service.createProject({ name: " Project " });
  assert.equal(created.ok, true);
  if (created.ok) assert.equal("ownerId" in created.data, false);
  assert.equal((await f.service.getProject({ projectId })).ok, true);
  assert.equal((await f.service.updateProject({ projectId, description: null })).ok, true);
  assert.equal((await f.service.listProjects({ limit: 10, offset: 5 })).ok, true);
  assert.equal(f.remaining.length, 0);
});

test("new notes preserve original content, nullable date and version 1 without snapshots", async () => {
  const f = fixture([
    begin,
    { sql: /select .*for share$/, rows: [[projectId]], inspect: scoped },
    {
      sql: /^insert into "notes"/,
      rows: [noteRow],
      inspect: (_, params) => {
        assert.ok(params.includes(content));
        assert.ok(params.includes(null));
      },
    },
    commit,
  ]);
  const result = await f.service.createNote({ projectId, title: "Title", content });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.version, 1);
    assert.equal(result.data.content, content);
    assert.equal(result.data.noteDate, null);
  }
  assert.equal(f.remaining.length, 0);
  assert.ok(!f.calls.some((sql) => sql.includes('insert into "note_revisions"')));
});

test("note reads expose a coherent version and lists omit content with deterministic ordering", async () => {
  const f = fixture([
    { sql: /select .*coalesce\(\(select max/, rows: [[...noteRow, 1]], inspect: noteScoped },
    { sql: /^select/, rows: [[projectId]], inspect: scoped },
    {
      sql: /select .*order by "notes"\."updated_at" desc, "notes"\."id" desc/,
      rows: [],
      inspect: (sql, params) => {
        scoped(sql, params);
        assert.doesNotMatch(sql, /"notes"\."content"/);
      },
    },
  ]);
  const result = await f.service.getNote({ projectId, noteId });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.version, 1);
  assert.deepEqual(await f.service.listNotes({ projectId }), { ok: true, data: [] });
});

for (const lastVersion of [null, 1, 5]) {
  test(`meaningful edits archive outgoing version ${(lastVersion ?? 0) + 1} before updating`, async () => {
    const version = (lastVersion ?? 0) + 1;
    const f = fixture([
      begin,
      lockNote,
      history(lastVersion),
      {
        sql: /^insert into "note_revisions"/,
        inspect: (_, params) => {
          assert.ok(params.includes(version));
          assert.ok(params.includes(content));
          assert.ok(!params.includes("Changed"));
        },
      },
      {
        sql: /^update "notes"/,
        rows: [[noteId, projectId, "Title", "Changed", null, now, now]],
        inspect: noteScoped,
      },
      commit,
    ]);
    const result = await f.service.updateNote({
      projectId,
      noteId,
      expectedVersion: version,
      content: "Changed",
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.data.version, version + 1);
    assert.equal(f.remaining.length, 0);
  });
}

for (const change of [{ title: "New title" }, { noteDate: "2024-02-29" }]) {
  test(`metadata-only note edit archives the outgoing state: ${Object.keys(change)[0]}`, async () => {
    const nextTitle = "title" in change ? change.title : "Title";
    const nextDate = "noteDate" in change ? change.noteDate : null;
    const f = fixture([
      begin,
      lockNote,
      history(null),
      {
        sql: /^insert into "note_revisions"/,
        inspect: (_, params) => {
          assert.ok(params.includes("Title"));
          assert.ok(params.includes(content));
          assert.ok(params.includes(null));
        },
      },
      {
        sql: /^update "notes"/,
        rows: [[noteId, projectId, nextTitle, content, nextDate, now, now]],
        inspect: (sql, params) => {
          noteScoped(sql, params);
          assert.doesNotMatch(sql.split(" where ")[0]!, /"project_id" =/);
        },
      },
      commit,
    ]);
    const result = await f.service.updateNote({ projectId, noteId, expectedVersion: 1, ...change });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.version, 2);
      assert.equal(result.data.content, content);
      assert.equal(result.data.title, nextTitle);
      assert.equal(result.data.noteDate, nextDate);
    }
    assert.equal(f.remaining.length, 0);
  });
}

test("another project ID cannot reassign a note or bypass its original project scope", async () => {
  const f = fixture([
    begin,
    {
      sql: /select .*for update of "notes"$/,
      inspect: (sql, params) => {
        assert.match(sql, /"notes"\."project_id" = \$/);
        assert.match(sql, /"notes"\."id" = \$/);
        assert.ok(params.includes(otherProjectId));
        assert.ok(params.includes(noteId));
        assert.ok(params.includes("user-a"));
      },
    },
    rollback,
  ]);
  failure(
    await f.service.updateNote({
      projectId: otherProjectId,
      noteId,
      expectedVersion: 1,
      content: "Moved",
    }),
    "NOT_FOUND",
  );
  assert.equal(f.remaining.length, 0);
});

test("no-op edits do not insert snapshots or update timestamps", async () => {
  const f = fixture([begin, lockNote, history(null), commit]);
  const result = await f.service.updateNote({ projectId, noteId, expectedVersion: 1, content });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.version, 1);
    assert.deepEqual(result.data.updatedAt, now);
  }
  assert.equal(f.remaining.length, 0);
});

test("stale submissions are rejected after locking, even when requested values are a no-op", async () => {
  const f = fixture([begin, lockNote, history(1), rollback]);
  failure(
    await f.service.updateNote({ projectId, noteId, expectedVersion: 1, content }),
    "CONFLICT",
  );
  assert.equal(f.remaining.length, 0);
  assert.ok(!f.calls.some((sql) => /^(insert|update) /.test(sql)));
});

test("failed update after snapshot insertion rolls back and returns no driver details", async () => {
  const f = fixture([
    begin,
    lockNote,
    history(null),
    { sql: /^insert into "note_revisions"/ },
    { sql: /^update "notes"/, error: new Error("postgres://secret:password private note content") },
    rollback,
  ]);
  const result = await f.service.updateNote({
    projectId,
    noteId,
    expectedVersion: 1,
    content: "Changed",
  });
  failure(result, "UNAVAILABLE");
  assert.ok(!JSON.stringify(result).includes("password"));
  assert.equal(f.remaining.length, 0);
});

test("missing update result rolls back its snapshot instead of reporting success", async () => {
  const f = fixture([
    begin,
    lockNote,
    history(null),
    { sql: /^insert into "note_revisions"/ },
    { sql: /^update "notes"/ },
    rollback,
  ]);
  failure(
    await f.service.updateNote({ projectId, noteId, expectedVersion: 1, content: "Changed" }),
    "NOT_FOUND",
  );
  assert.equal(f.remaining.length, 0);
});

test("failed commit is never reported as a successful note edit", async () => {
  const f = fixture([
    begin,
    lockNote,
    history(null),
    { sql: /^insert into "note_revisions"/ },
    { sql: /^update "notes"/, rows: [noteRow] },
    { sql: /^commit/, error: new Error("connection lost") },
    rollback,
  ]);
  failure(
    await f.service.updateNote({ projectId, noteId, expectedVersion: 1, content: "Changed" }),
    "UNAVAILABLE",
  );
  assert.equal(f.remaining.length, 0);
});

test("session and database failures return safe errors", async () => {
  const f = fixture([{ sql: /^select/, error: new Error("private database configuration") }]);
  failure(await f.service.listProjects(), "UNAVAILABLE");
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const service = createWorkspaceService({
    db,
    getSession: async () => {
      throw new Error("private session error");
    },
  });
  assert.deepEqual(await service.listProjects(), {
    ok: false,
    error: { code: "UNAVAILABLE", message: "Workspace is unavailable. Please try again." },
  });
});
