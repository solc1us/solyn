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
function fixture(steps: Step[] = [], userId: string | null | (() => string | null) = "user-a") {
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
      const id = typeof userId === "function" ? userId() : userId;
      return id === null ? null : { user: { id } };
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
  () => service.searchNotes({ projectId, query: "budget" }),
  () => service.searchOwnedNotes({ query: "budget" }),
  () => service.getNote({ projectId, noteId }),
  () => service.createNote({ projectId, title: "Title", content }),
  () => service.updateNote({ projectId, noteId, expectedVersion: 1, content: "Changed" }),
];

test("every domain operation denies unauthenticated callers before any SQL", async () => {
  const f = fixture([], null);
  for (const call of validCalls(f.service)) failure(await call(), "UNAUTHENTICATED");
  assert.equal(f.calls.length, 0);
  assert.equal(f.sessionCalls(), 10);
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

test("note search validates strict inputs, query bounds and pagination before SQL", async () => {
  assert.deepEqual(contracts.searchNotesInput.parse({ projectId, query: " Budget \n" }), {
    projectId,
    query: "Budget",
    limit: 20,
    offset: 0,
  });
  assert.equal(
    contracts.searchNotesInput.safeParse({
      projectId,
      query: "x".repeat(200),
      limit: 50,
      offset: 100_000,
    }).success,
    true,
  );
  assert.equal(contracts.searchNotesInput.safeParse({ projectId, query: "📚" }).success, true);
  const f = fixture();
  const invalid = [
    undefined,
    null,
    {},
    { query: "budget" },
    { projectId: "invalid", query: "budget" },
    ...[undefined, null, 1, "", " \n\t", "x".repeat(201), "a\0b", "\uD800", "\uDC00"].map(
      (query) => ({ projectId, query }),
    ),
    ...[0, -1, 51, 1.5, "20", null, Infinity, NaN].map((limit) => ({
      projectId,
      query: "budget",
      limit,
    })),
    ...[-1, 100_001, 1.5, "0", null, Infinity, NaN].map((offset) => ({
      projectId,
      query: "budget",
      offset,
    })),
    { projectId, query: "budget", ownerId: "user-b" },
    { projectId, query: "budget", userId: "user-b" },
  ];
  for (const input of invalid) failure(await f.service.searchNotes(input), "INVALID_INPUT");
  assert.equal(f.calls.length, 0);
});

const searchProject: Step = {
  sql: /^select .*from "projects"/,
  rows: [[projectId]],
  inspect: scoped,
};
function searchScoped(sql: string, params: unknown[]) {
  scoped(sql, params);
  assert.match(sql, /"notes"\."project_id" = \$/);
  assert.match(sql, /exists \(select .*"projects"\."id" = "notes"\."project_id"/);
  assert.match(
    sql,
    /"notes"\."title" ilike \$\d+ escape '!'\) or \("notes"\."content" ilike \$\d+ escape '!'/,
  );
  assert.match(
    sql,
    /order by "notes"\."title" ilike \$\d+ escape '!' desc, "notes"\."updated_at" desc, "notes"\."id" desc limit \$/,
  );
}

test("note search matches title or content case-insensitively and selects only bounded metadata", async () => {
  const f = fixture([
    searchProject,
    {
      sql: /^select .*from "notes"/,
      rows: [
        [noteId, projectId, "BUDGET decision", "Opening text", null, now],
        [
          otherProjectId,
          projectId,
          "Meeting",
          "Context before BuDgEt and after",
          "2025-12-01",
          now,
        ],
      ],
      inspect: (sql, params) => {
        searchScoped(sql, params);
        assert.ok(params.includes("%BuDgEt%"));
        assert.ok(params.includes("BuDgEt"));
        assert.ok(!sql.includes("BuDgEt"));
        assert.equal(params.at(-1), 20);
        const projection = sql.split(' from "notes"')[0]!;
        assert.match(
          projection,
          /substring\("content" from greatest\(1, strpos\(lower\("content"\), lower\(\$\d+\)\) - 80\) for 320\) as "excerpt"/,
        );
        assert.doesNotMatch(projection, /"owner_id"|"created_at"|select \*/);
      },
    },
  ]);
  const result = await f.service.searchNotes({ projectId, query: " BuDgEt " });
  assert.deepEqual(result, {
    ok: true,
    data: [
      {
        id: noteId,
        projectId,
        title: "BUDGET decision",
        excerpt: "Opening text",
        noteDate: null,
        updatedAt: now,
      },
      {
        id: otherProjectId,
        projectId,
        title: "Meeting",
        excerpt: "Context before BuDgEt and after",
        noteDate: "2025-12-01",
        updatedAt: now,
      },
    ],
  });
  assert.equal(f.remaining.length, 0);
});

for (const [query, pattern] of [
  ["%", "%!%%"],
  ["_", "%!_%"],
  ["!", "%!!%"],
  ["\\", "%\\%"],
  ["50%_!\\path", "%50!%!_!!\\path%"],
  ["' OR 1=1 --", "%' OR 1=1 --%"],
]) {
  test(`note search treats ${JSON.stringify(query)} as literal parameterized text`, async () => {
    const f = fixture([
      searchProject,
      {
        sql: /^select .*from "notes"/,
        inspect: (sql, params) => {
          searchScoped(sql, params);
          assert.equal(params.filter((param) => param === pattern).length, 3);
          assert.ok(params.includes(query)); // Raw literal text for excerpt positioning.
          assert.ok(!sql.includes("OR 1=1"));
        },
      },
    ]);
    assert.deepEqual(await f.service.searchNotes({ projectId, query }), { ok: true, data: [] });
    assert.equal(f.remaining.length, 0);
  });
}

test("note search requests title-first, recent, ID-stable ordering with bounded offset pagination", async () => {
  const f = fixture([
    searchProject,
    {
      sql: /^select .*from "notes"/,
      rows: [[noteId, projectId, "Budget", "Excerpt", null, now]],
      inspect: (sql, params) => {
        searchScoped(sql, params);
        assert.match(sql, /limit \$\d+ offset \$\d+$/);
        assert.deepEqual(params.slice(-2), [2, 3]);
      },
    },
  ]);
  const result = await f.service.searchNotes({ projectId, query: "budget", limit: 2, offset: 3 });
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual(
      result.data.map((note) => note.id),
      [noteId],
    );
  assert.equal(f.remaining.length, 0);
});

test("note search returns no matches and rejects expired or invalid sessions before SQL", async () => {
  let user: string | null = "user-a";
  const f = fixture(
    [searchProject, { sql: /^select .*from "notes"/, inspect: searchScoped }],
    () => user,
  );
  assert.deepEqual(await f.service.searchNotes({ projectId, query: "budget" }), {
    ok: true,
    data: [],
  });
  for (user of [null, ""])
    failure(await f.service.searchNotes({ projectId, query: "budget" }), "UNAUTHENTICATED");
  assert.equal(f.calls.length, 2);
  assert.equal(f.sessionCalls(), 3);
});

test("note search rejects foreign and nonexistent projects identically without reading notes", async () => {
  for (const id of [projectId, otherProjectId]) {
    const f = fixture(
      [
        {
          sql: /^select .*from "projects"/,
          inspect: (sql, params) => {
            assert.match(sql, /"projects"\."id" = \$\d+\) and \("projects"\."owner_id" = \$/);
            assert.deepEqual(params, [id, "user-b"]);
          },
        },
      ],
      "user-b",
    );
    assert.deepEqual(await f.service.searchNotes({ projectId: id, query: "budget" }), {
      ok: false,
      error: { code: "NOT_FOUND", message: "Resource not found." },
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.remaining.length, 0);
  }
});

test("owner search validates optional scope, strict fields and existing query/pagination bounds", async () => {
  assert.deepEqual(contracts.searchOwnedNotesInput.parse({ query: " NFC \n" }), {
    query: "NFC",
    limit: 20,
    offset: 0,
  });
  assert.equal(contracts.searchNotesInput.safeParse({ query: "NFC" }).success, false);
  assert.equal(
    contracts.searchOwnedNotesInput.safeParse({
      query: "x".repeat(200),
      projectId,
      limit: 50,
      offset: 100_000,
    }).success,
    true,
  );
  const f = fixture();
  for (const input of [
    undefined,
    null,
    {},
    ...[null, 1, "", " \n", "x".repeat(201), "a\0b", "\uD800", "\uDC00"].map((query) => ({
      query,
    })),
    ...[null, "bad", 1].map((projectId) => ({ query: "NFC", projectId })),
    ...[0, -1, 51, 1.5, "20", null].map((limit) => ({ query: "NFC", limit })),
    ...[-1, 100_001, 1.5, "0", null].map((offset) => ({ query: "NFC", offset })),
    { query: "NFC", ownerId: "user-b" },
    { query: "NFC", projectId, userId: "user-b" },
  ])
    failure(await f.service.searchOwnedNotes(input), "INVALID_INPUT");
  assert.equal(f.calls.length, 0);
});

function ownerSearchScoped(sql: string, params: unknown[], ownerId = "user-a") {
  assert.match(
    sql,
    /from "notes" inner join "projects" on "projects"\."id" = "notes"\."project_id"/,
  );
  // Ownership must govern BOTH title and content matches, not one side of OR.
  assert.match(sql, /where \(\("projects"\."owner_id" = \$\d+\) and /);
  assert.match(
    sql,
    /\(\("notes"\."title" ilike \$\d+ escape '!'\) or \("notes"\."content" ilike \$\d+ escape '!'\)\)\)\) order by/,
  );
  assert.ok(params.includes(ownerId));
  assert.match(
    sql,
    /order by "notes"\."title" ilike \$\d+ escape '!' desc, "notes"\."updated_at" desc, "notes"\."id" desc limit \$\d+(?: offset \$\d+)?$/,
  );
  const projection = sql.split(' from "notes"')[0]!;
  assert.match(projection, /"projects"\."name"/);
  assert.match(
    projection,
    /substring\("notes"\."content" from greatest\(1, strpos\(lower\("notes"\."content"\), lower\(\$\d+\)\) - 80\) for 320\) as "excerpt"/,
  );
  assert.doesNotMatch(projection, /"owner_id"|"description"|"created_at"|select \*/);
}

const ownedSearchRow = [noteId, projectId, "Orion", "NFC decision", "Not approved", null, now];
test("owner search returns multiple owned projects with exact source metadata in one read", async () => {
  const excerpt = "📚".repeat(320);
  const f = fixture([
    {
      sql: /^select .*from "notes"/,
      rows: [
        ownedSearchRow,
        [otherProjectId, otherProjectId, "Vega", "Meeting", excerpt, "2025-12-01", now],
      ],
      inspect: (sql, params) => {
        ownerSearchScoped(sql, params);
        assert.ok(params.includes("%NFC%"));
        assert.ok(params.includes("NFC"));
        assert.ok(!sql.includes("NFC"));
        assert.doesNotMatch(sql, /"notes"\."project_id" = \$/); // No implicit single-project scope.
      },
    },
  ]);
  assert.deepEqual(await f.service.searchOwnedNotes({ query: " NFC " }), {
    ok: true,
    data: [
      {
        id: noteId,
        projectId,
        projectName: "Orion",
        title: "NFC decision",
        excerpt: "Not approved",
        noteDate: null,
        updatedAt: now,
      },
      {
        id: otherProjectId,
        projectId: otherProjectId,
        projectName: "Vega",
        title: "Meeting",
        excerpt,
        noteDate: "2025-12-01",
        updatedAt: now,
      },
    ],
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.remaining.length, 0);
});

test("owner search scopes mixed-owner candidates and excludes absent parents before returning metadata", async () => {
  // Reference rows simulate the JOIN/owner result after checking its SQL shape;
  // this is not execution of ownership predicates by a real PostgreSQL server.
  const candidates = [
    { ownerId: "user-a", row: ownedSearchRow },
    {
      ownerId: "user-b",
      row: [otherProjectId, otherProjectId, "Private project", "NFC", "Private content", null, now],
    },
    {
      ownerId: null,
      row: [projectId, noteId, "Deleted parent", "NFC", "Orphan content", null, now],
    },
  ];
  for (const ownerId of ["user-a", "user-b"]) {
    const step: Step = {
      sql: /^select .*from "notes"/,
      inspect: (sql, params) => {
        ownerSearchScoped(sql, params, ownerId);
        assert.ok(!params.includes(ownerId === "user-a" ? "user-b" : "user-a"));
        step.rows = candidates
          .filter((candidate) => candidate.ownerId === ownerId)
          .map((candidate) => candidate.row);
      },
    };
    const f = fixture([step], ownerId);
    const result = await f.service.searchOwnedNotes({ query: "NFC" });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(
        result.data.map((note) => note.projectName),
        [ownerId === "user-a" ? "Orion" : "Private project"],
      );
      assert.equal(result.data.length, 1);
    }
    assert.equal(f.remaining.length, 0);
  }
});

test("owner search optional owned-project filter retains ownership and scopes note metadata", async () => {
  const f = fixture([
    {
      sql: /^select .*from "notes"/,
      rows: [ownedSearchRow],
      inspect: (sql, params) => {
        ownerSearchScoped(sql, params);
        assert.match(sql, /"notes"\."project_id" = \$/);
        assert.ok(params.includes(projectId));
      },
    },
  ]);
  const result = await f.service.searchOwnedNotes({ projectId, query: "NFC" });
  assert.equal(result.ok, true);
  if (result.ok)
    assert.deepEqual(
      result.data.map((n) => [n.projectId, n.projectName]),
      [[projectId, "Orion"]],
    );
  assert.equal(f.remaining.length, 0);
});

test("owner search foreign and missing project filters reveal neither notes nor project names", async () => {
  for (const id of [projectId, otherProjectId]) {
    const f = fixture(
      [
        {
          sql: /^select .*from "notes"/,
          inspect: (sql, params) => {
            ownerSearchScoped(sql, params, "user-b");
            assert.match(sql, /"notes"\."project_id" = \$/);
            assert.ok(params.includes(id));
            assert.ok(!params.includes("user-a"));
          },
        },
      ],
      "user-b",
    );
    assert.deepEqual(await f.service.searchOwnedNotes({ projectId: id, query: "NFC" }), {
      ok: true,
      data: [],
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.remaining.length, 0);
  }
});

test("owner search empty results require an owned existing parent via inner join", async () => {
  const f = fixture([{ sql: /^select .*from "notes"/, inspect: ownerSearchScoped }]);
  assert.deepEqual(await f.service.searchOwnedNotes({ query: "NFC" }), { ok: true, data: [] });
  assert.equal(f.remaining.length, 0);
});

test("owner search revalidates session identity on every read and rejects expired sessions before SQL", async () => {
  let owner: string | null = "user-a";
  const f = fixture(
    ["user-a", "user-b"].map((id) => ({
      sql: /^select .*from "notes"/,
      inspect: (sql: string, params: unknown[]) => {
        ownerSearchScoped(sql, params, id);
        assert.ok(!params.includes(id === "user-a" ? "user-b" : "user-a"));
      },
    })),
    () => owner,
  );
  for (owner of ["user-a", "user-b"])
    assert.deepEqual(await f.service.searchOwnedNotes({ query: "NFC" }), { ok: true, data: [] });
  for (owner of [null, ""])
    failure(await f.service.searchOwnedNotes({ query: "NFC", projectId }), "UNAUTHENTICATED");
  assert.equal(f.calls.length, 2);
  assert.equal(f.sessionCalls(), 4);
});

for (const [query, pattern] of [
  ["%", "%!%%"],
  ["_", "%!_%"],
  ["!", "%!!%"],
  ["\\", "%\\%"],
  ["50%_!\\path", "%50!%!_!!\\path%"],
  ["' OR 1=1 --", "%' OR 1=1 --%"],
]) {
  test(`owner search escapes ${JSON.stringify(query)} as literal parameterized text`, async () => {
    const f = fixture([
      {
        sql: /^select .*from "notes"/,
        inspect: (sql, params) => {
          ownerSearchScoped(sql, params);
          assert.equal(params.filter((p) => p === pattern).length, 3);
          assert.ok(params.includes(query));
          assert.ok(!sql.includes("OR 1=1"));
        },
      },
    ]);
    assert.deepEqual(await f.service.searchOwnedNotes({ query }), { ok: true, data: [] });
    assert.equal(f.remaining.length, 0);
  });
}

test("owner search orders globally by title match, edit time and unique ID with bounded pagination", async () => {
  for (const input of [
    { query: "NFC" },
    { query: "NFC", limit: 50, offset: 100_000 },
    { query: "NFC", limit: 2, offset: 3 },
  ]) {
    const f = fixture([
      {
        sql: /^select .*from "notes"/,
        inspect: (sql, params) => {
          ownerSearchScoped(sql, params);
          assert.deepEqual(
            input.offset ? params.slice(-2) : params.slice(-1),
            input.offset ? [input.limit ?? 20, input.offset] : [input.limit ?? 20],
          );
        },
      },
    ]);
    assert.deepEqual(await f.service.searchOwnedNotes(input), { ok: true, data: [] });
    assert.equal(f.remaining.length, 0);
  }
});

test("owner search hides session and SQL failures without leaking metadata", async () => {
  const privateError = new Error("synthetic private project name, SQL and credentials");
  for (const f of [
    fixture([], () => {
      throw privateError;
    }),
    fixture([{ sql: /^select .*from "notes"/, error: privateError }]),
  ]) {
    assert.deepEqual(await f.service.searchOwnedNotes({ query: "NFC" }), {
      ok: false,
      error: { code: "UNAVAILABLE", message: "Workspace is unavailable. Please try again." },
    });
    assert.equal(f.remaining.length, 0);
  }
});

test("note search safely handles session, project lookup and search database errors", async () => {
  const privateError = new Error("synthetic private driver detail");
  const cases = [
    fixture([], () => {
      throw privateError;
    }),
    fixture([{ sql: /^select .*from "projects"/, error: privateError }]),
    fixture([searchProject, { sql: /^select .*from "notes"/, error: privateError }]),
  ];
  for (const f of cases) {
    assert.deepEqual(await f.service.searchNotes({ projectId, query: "budget" }), {
      ok: false,
      error: { code: "UNAVAILABLE", message: "Workspace is unavailable. Please try again." },
    });
    assert.equal(f.remaining.length, 0);
  }
});
