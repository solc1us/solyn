import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createDb } from "@solyn/db";
import * as contracts from "./contracts";
import { createWorkspaceService } from "./service";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const noteId = "33333333-3333-4333-8333-333333333333";
const otherProjectId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-01-01T00:00:00Z");
const task = {
  id: taskId,
  projectId,
  title: "Task",
  description: null as string | null,
  status: "todo",
  priority: null as string | null,
  assignee: null as string | null,
  dueDate: null as string | null,
  sourceNoteId: null as string | null,
  version: 1,
  createdAt: now,
  updatedAt: now,
  completedAt: null as Date | null,
};
const row = (overrides: Partial<typeof task> = {}) => Object.values({ ...task, ...overrides });
type Step = {
  sql: RegExp;
  rows?: unknown[][];
  inspect?: (sql: string, params: unknown[]) => void;
  error?: Error;
};
// Existing offline pattern: real Drizzle SQL with a scripted, non-network driver.
// Does not simulate PostgreSQL locks/MVCC, CHECK execution or durable persistence.
function fixture(steps: Step[] = [], user: string | null | (() => string | null) = "user-a") {
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
  db.$client.connect = (async () => ({
    query,
    on() {},
    off() {},
    release() {},
  })) as unknown as typeof db.$client.connect;
  let sessions = 0;
  const service = createWorkspaceService({
    db,
    getSession: async () => {
      sessions++;
      const id = typeof user === "function" ? user() : user;
      return id ? { user: { id } } : null;
    },
  });
  return { service, remaining, calls, sessions: () => sessions };
}
const begin: Step = { sql: /^begin.*read committed/ };
const commit: Step = { sql: /^commit/ };
const rollback: Step = { sql: /^rollback/ };
function ownerScope(sql: string, params: unknown[], owner = "user-a") {
  assert.match(sql, /"projects"\."owner_id" = \$/);
  assert.ok(params.includes(owner));
}
function taskScope(sql: string, params: unknown[]) {
  ownerScope(sql, params);
  assert.match(sql, /exists \(select/);
  assert.ok(params.includes(taskId));
}
const project: Step = {
  sql: /select .*from "projects".*for share$/,
  rows: [[projectId]],
  inspect: (sql, params) => {
    assert.match(sql, /"owner_id" = \$/);
    assert.ok(params.includes("user-a"));
    assert.ok(params.includes(projectId));
  },
};
function lock(overrides: Partial<typeof task> = {}): Step {
  return {
    sql: /select .*from "tasks".*for update of "tasks"$/,
    rows: [row(overrides)],
    inspect: taskScope,
  };
}
function failed(result: { ok: boolean; error?: { code: string; message: string } }, code: string) {
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, code);
  assert.doesNotMatch(result.error?.message ?? "", /secret|postgres|SELECT/i);
}
const validInputs = {
  createTask: { projectId, title: "Task" },
  getTask: { taskId },
  listTasks: { projectId },
  listOwnedTasks: {},
  updateTask: { taskId, expectedVersion: 1, title: "Changed" },
  deleteTask: { taskId, expectedVersion: 1 },
};

test("all six task operations authenticate freshly and deny expired sessions before SQL", async () => {
  const f = fixture([], null);
  for (const [operation, input] of Object.entries(validInputs)) {
    failed(await f.service[operation as keyof typeof validInputs](input), "UNAUTHENTICATED");
  }
  assert.equal(f.sessions(), 6);
  assert.deepEqual(f.calls, []);
});

test("strict task contracts reject unsupported fields, bad text, invalid dates/enums/versions and empty changes", () => {
  for (const extra of [{ ownerId: "user-b" }, { completedAt: now }, { version: 5 }, { id: taskId }])
    assert.equal(
      contracts.createTaskInput.safeParse({ ...validInputs.createTask, ...extra }).success,
      false,
    );
  for (const title of ["", " \n\t", "a".repeat(301), "bad\0", "bad\ud800"])
    assert.equal(contracts.createTaskInput.safeParse({ projectId, title }).success, false);
  for (const extra of [
    { description: "a".repeat(5001) },
    { assignee: "a".repeat(201) },
    { description: "\0" },
    { assignee: "\udfff" },
    { projectId: "bad" },
    { sourceNoteId: "bad" },
    { status: "overdue" },
    { status: null },
    { priority: "critical" },
  ])
    assert.equal(
      contracts.createTaskInput.safeParse({ ...validInputs.createTask, ...extra }).success,
      false,
    );
  for (const dueDate of [
    "2025-02-29",
    "2024-02-30",
    "0000-01-01",
    "2026-1-1",
    "2026-04-31",
    "2026-01-01T00:00:00Z",
  ])
    assert.equal(
      contracts.createTaskInput.safeParse({ ...validInputs.createTask, dueDate }).success,
      false,
    );
  assert.equal(
    contracts.createTaskInput.parse({ projectId, title: " Task 😀 ", dueDate: "2024-02-29" }).title,
    "Task 😀",
  );
  assert.equal(contracts.createTaskInput.parse(validInputs.createTask).status, "todo");
  for (const extra of [
    {},
    { title: undefined },
    { projectId: otherProjectId },
    { ownerId: "user-b" },
    { expectedVersion: 0, title: "X" },
    { expectedVersion: 2147483648, title: "X" },
  ])
    assert.equal(
      contracts.updateTaskInput.safeParse({ taskId, expectedVersion: 1, ...extra }).success,
      false,
    );
  assert.equal(contracts.updateTaskInput.safeParse({ taskId, title: "X" }).success, false);
  assert.equal(contracts.deleteTaskInput.safeParse({ taskId }).success, false);
  assert.equal(contracts.deleteTaskInput.safeParse({ taskId, expectedVersion: 0 }).success, false);
  assert.equal(contracts.taskInput.safeParse({ taskId: "bad" }).success, false);
  for (const input of [
    { limit: 101 },
    { offset: -1 },
    { offset: 100001 },
    { status: "overdue" },
    { dueDateFrom: "2026-02-01", dueDateTo: "2026-01-01" },
    { dueDateTo: "2026-02-30" },
    { ownerId: "user-b" },
  ])
    assert.equal(contracts.listOwnedTasksInput.safeParse(input).success, false);
  assert.equal(contracts.listTasksInput.safeParse({}).success, false);
  assert.equal(
    contracts.updateTaskInput.parse({ taskId, expectedVersion: 1, description: null }).description,
    null,
  );
});

test("invalid task requests fail safely before SQL", async () => {
  const f = fixture();
  failed(await f.service.createTask({ projectId, title: "X", ownerId: "user-b" }), "INVALID_INPUT");
  failed(await f.service.updateTask({ taskId, expectedVersion: 1 }), "INVALID_INPUT");
  failed(await f.service.deleteTask({ taskId }), "INVALID_INPUT");
  failed(await f.service.listOwnedTasks({ dueDateFrom: "2026-02-30" }), "INVALID_INPUT");
  assert.deepEqual(f.calls, []);
});

for (const status of ["todo", "done"] as const)
  test(`create task ${status} defaults and confirmed transaction`, async () => {
    const completedAt = status === "done" ? now : null;
    const f = fixture([
      begin,
      project,
      {
        sql: /insert into "tasks"/,
        rows: [row({ status, completedAt })],
        inspect: (sql, params) => {
          assert.ok(params.includes("Task"));
          assert.ok(params.includes(projectId));
          assert.ok(params.includes(status));
          assert.equal(params.filter((v) => v === null).length, status === "done" ? 5 : 6);
          assert.match(sql, status === "done" ? /now\(\)/ : /values/);
        },
      },
      commit,
    ]);
    const result = await f.service.createTask({
      projectId,
      title: " Task ",
      ...(status === "done" ? { status } : {}),
    });
    assert.ok(result.ok);
    assert.equal(result.data.version, 1);
    assert.equal(result.data.status, status);
    assert.equal(
      result.data.completedAt?.toISOString() ?? null,
      completedAt?.toISOString() ?? null,
    );
    assert.deepEqual(f.remaining, []);
  });

test("create validates a source note using the same owned project and a share lock", async () => {
  const f = fixture([
    begin,
    project,
    {
      sql: /select .*from "notes".*for share of "notes"$/,
      rows: [[noteId]],
      inspect: (sql, params) => {
        ownerScope(sql, params);
        assert.ok(params.includes(projectId));
        assert.ok(params.includes(noteId));
      },
    },
    {
      sql: /insert into "tasks"/,
      rows: [
        row({
          sourceNoteId: noteId,
          dueDate: "2024-02-29",
          assignee: "PIC",
          priority: "high",
          description: "  exact\ntext ",
        }),
      ],
      inspect: (_sql, params) => {
        for (const value of [noteId, "2024-02-29", "PIC", "high", "  exact\ntext "])
          assert.ok(params.includes(value));
      },
    },
    commit,
  ]);
  const result = await f.service.createTask({
    projectId,
    title: "Task",
    sourceNoteId: noteId,
    dueDate: "2024-02-29",
    assignee: "PIC",
    priority: "high",
    description: "  exact\ntext ",
  });
  assert.ok(result.ok);
  assert.deepEqual(f.remaining, []);
});

for (const reason of ["foreign", "missing", "different owned project"])
  test(`source note ${reason} is indistinguishable and cannot create a task`, async () => {
    const f = fixture([
      begin,
      project,
      {
        sql: /select .*from "notes"/,
        rows: [],
        inspect: (sql, params) => {
          ownerScope(sql, params);
          assert.ok(params.includes(projectId));
          assert.ok(params.includes(noteId));
        },
      },
      rollback,
    ]);
    failed(
      await f.service.createTask({ projectId, title: "Task", sourceNoteId: noteId }),
      "NOT_FOUND",
    );
    assert.deepEqual(f.remaining, []);
    assert.ok(!f.calls.some((sql) => /insert/.test(sql)));
  });

for (const reason of ["foreign", "missing"])
  test(`${reason} task/project cannot be read, mutated or explicitly listed`, async () => {
    for (const operation of [
      "getTask",
      "updateTask",
      "deleteTask",
      "listTasks",
      "createTask",
    ] as const) {
      const write = ["updateTask", "deleteTask", "createTask"].includes(operation);
      const f = fixture([
        ...(write ? [begin] : []),
        {
          sql: /select .*from "(?:tasks|projects)"/,
          rows: [],
          inspect: (sql, params) => {
            assert.match(sql, /"owner_id" = \$/);
            assert.ok(params.includes("user-a"));
          },
        },
        ...(write ? [rollback] : []),
      ]);
      failed(await f.service[operation](validInputs[operation]), "NOT_FOUND");
      assert.deepEqual(f.remaining, []);
    }
  });

test("task reads return only selected task fields and change account scope on every call", async () => {
  let owner = "user-a";
  const f = fixture(
    [
      { sql: /select .*from "tasks"/, rows: [row()], inspect: taskScope },
      {
        sql: /select .*from "tasks"/,
        rows: [],
        inspect: (sql, params) => ownerScope(sql, params, "user-b"),
      },
    ],
    () => owner,
  );
  const first = await f.service.getTask({ taskId });
  assert.ok(first.ok);
  assert.deepEqual(first.data, task);
  owner = "user-b";
  failed(await f.service.getTask({ taskId }), "NOT_FOUND");
  assert.equal(f.sessions(), 2);
  assert.deepEqual(f.remaining, []);
});

test("bounded owner-wide task listing filters joined ownership/status/priority/dates before deterministic pagination", async () => {
  const f = fixture([
    {
      sql: /select .*from "tasks" inner join "projects"/,
      rows: [],
      inspect: (sql, params) => {
        ownerScope(sql, params);
        for (const value of [projectId, "blocked", "high", "2026-01-01", "2026-12-31", 7, 10])
          assert.ok(params.includes(value));
        assert.match(sql, /"tasks"\."status" = \$/);
        assert.match(sql, /"tasks"\."priority" = \$/);
        assert.match(sql, /"tasks"\."due_date" >= \$/);
        assert.match(sql, /"tasks"\."due_date" <= \$/);
        assert.match(
          sql,
          /where .*order by "tasks"\."updated_at" desc, "tasks"\."id" desc limit \$\d+ offset \$\d+$/,
        );
        assert.match(sql, /"projects"\."name"/);
        assert.doesNotMatch(sql, /select .*"description"/);
      },
    },
  ]);
  assert.deepEqual(
    await f.service.listOwnedTasks({
      projectId,
      status: "blocked",
      priority: "high",
      dueDateFrom: "2026-01-01",
      dueDateTo: "2026-12-31",
      limit: 7,
      offset: 10,
    }),
    { ok: true, data: [] },
  );
  assert.deepEqual(f.remaining, []);
});

test("project task list rechecks project ownership and joins owner predicate; null priority is an explicit filter", async () => {
  const f = fixture([
    {
      sql: /select .*from "projects"/,
      rows: [[projectId]],
      inspect: (_sql, params) => assert.ok(params.includes("user-a")),
    },
    {
      sql: /select .*from "tasks" inner join "projects"/,
      rows: [],
      inspect: (sql, params) => {
        ownerScope(sql, params);
        assert.ok(params.includes(projectId));
        assert.match(sql, /"tasks"\."priority" is null/);
        assert.ok(params.includes(50));
        assert.doesNotMatch(sql, /"tasks"\."due_date" [<>]/);
      },
    },
  ]);
  assert.deepEqual(await f.service.listTasks({ projectId, priority: null }), {
    ok: true,
    data: [],
  });
  assert.deepEqual(f.remaining, []);
});

test("owner-wide foreign/missing filters return no metadata and omitted project spans only the session owner", async () => {
  const f = fixture(
    Array.from({ length: 3 }, () => ({
      sql: /select .*inner join "projects"/,
      rows: [],
      inspect: ownerScope,
    })),
  );
  for (const input of [{ projectId: otherProjectId }, { projectId: noteId }, {}])
    assert.deepEqual(await f.service.listOwnedTasks(input), { ok: true, data: [] });
  assert.deepEqual(f.remaining, []);
});

for (const from of ["todo", "in_progress", "blocked", "done"])
  for (const to of ["todo", "in_progress", "blocked", "done"]) {
    test(`task status ${from} -> ${to} completion and version semantics`, async () => {
      const completedAt = from === "done" ? now : null;
      const nextCompleted = to === "done" ? now : null;
      const changed = from !== to;
      const f = fixture([
        begin,
        lock({ status: from, completedAt }),
        ...(changed
          ? [
              {
                sql: /update "tasks" set/,
                rows: [row({ status: to, version: 2, completedAt: nextCompleted })],
                inspect: (sql: string, params: unknown[]) => {
                  taskScope(sql, params);
                  assert.match(sql, /"version" = \$/);
                  assert.match(sql, /where .*"tasks"\."version" = \$/);
                  const dateValues = params.filter((v) => typeof v === "string" && /T.*Z$/.test(v));
                  assert.equal(dateValues.length, to === "done" ? 2 : 1);
                },
              },
            ]
          : []),
        commit,
      ]);
      const result = await f.service.updateTask({ taskId, expectedVersion: 1, status: to });
      assert.ok(result.ok);
      assert.equal(result.data.version, changed ? 2 : 1);
      assert.equal(
        result.data.completedAt?.toISOString() ?? null,
        nextCompleted?.toISOString() ?? null,
      );
      assert.deepEqual(f.remaining, []);
    });
  }

test("editing a done task preserves completion; nullable clears and omitted fields remain distinct", async () => {
  const initial = {
    status: "done",
    completedAt: now,
    priority: "high",
    description: "old",
    sourceNoteId: noteId,
    assignee: "PIC",
    dueDate: "2026-01-01",
  };
  const f = fixture([
    begin,
    lock(initial),
    {
      sql: /update "tasks"/,
      rows: [row({ status: "done", completedAt: now, version: 2, title: "Changed" })],
      inspect: (_sql, params) => {
        assert.ok(params.includes(now.toISOString()));
        assert.ok(params.includes("Changed"));
        assert.ok(!params.includes(noteId));
        assert.ok(!params.includes("PIC"));
        assert.ok(!params.includes("high"));
      },
    },
    commit,
  ]);
  const result = await f.service.updateTask({
    taskId,
    expectedVersion: 1,
    title: "Changed",
    description: null,
    priority: null,
    assignee: null,
    dueDate: null,
    sourceNoteId: null,
  });
  assert.ok(result.ok);
  assert.equal(result.data.completedAt?.toISOString(), now.toISOString());
  assert.deepEqual(f.remaining, []);
  const unchanged = fixture([begin, lock({ description: "Keep", sourceNoteId: noteId }), commit]);
  const noop = await unchanged.service.updateTask({ taskId, expectedVersion: 1, title: " Task " });
  assert.ok(noop.ok);
  assert.equal(noop.data.description, "Keep");
  assert.equal(noop.data.sourceNoteId, noteId);
  assert.equal(noop.data.version, 1);
  assert.equal(noop.data.updatedAt.toISOString(), now.toISOString());
  assert.deepEqual(unchanged.remaining, []);
});

test("changed task source must match its immutable owned project; rejected updates roll back", async () => {
  for (const allowed of [false, true]) {
    const f = fixture([
      begin,
      lock(),
      {
        sql: /select .*from "notes".*for share of "notes"$/,
        rows: allowed ? [[noteId]] : [],
        inspect: (sql, params) => {
          ownerScope(sql, params);
          assert.ok(params.includes(projectId));
          assert.ok(params.includes(noteId));
        },
      },
      ...(allowed
        ? [{ sql: /update "tasks"/, rows: [row({ sourceNoteId: noteId, version: 2 })] }, commit]
        : [rollback]),
    ]);
    const result = await f.service.updateTask({ taskId, expectedVersion: 1, sourceNoteId: noteId });
    if (allowed) assert.ok(result.ok);
    else failed(result, "NOT_FOUND");
    assert.deepEqual(f.remaining, []);
  }
});

test("stale versions conflict even for identical updates/deletion; overflow cannot wrap", async () => {
  for (const operation of ["updateTask", "deleteTask"] as const) {
    const stale = fixture([begin, lock({ version: 2 }), rollback]);
    failed(
      await stale.service[operation]({
        ...validInputs[operation],
        ...(operation === "updateTask" ? { title: "Task" } : {}),
      }),
      "CONFLICT",
    );
    assert.deepEqual(stale.remaining, []);
  }
  const f = fixture([begin, lock({ version: 2147483647 }), rollback]);
  failed(
    await f.service.updateTask({ taskId, expectedVersion: 2147483647, title: "Changed" }),
    "CONFLICT",
  );
  assert.deepEqual(f.remaining, []);
});

test("permanent deletion targets only the owned versioned task and commits before reporting success", async () => {
  const f = fixture([
    begin,
    lock({ sourceNoteId: noteId }),
    {
      sql: /^delete from "tasks"/,
      rows: [[taskId, projectId]],
      inspect: (sql, params) => {
        taskScope(sql, params);
        assert.match(sql, /"tasks"\."version" = \$/);
        assert.ok(params.includes(1));
      },
    },
    commit,
  ]);
  assert.deepEqual(await f.service.deleteTask({ taskId, expectedVersion: 1 }), {
    ok: true,
    data: { id: taskId, projectId },
  });
  assert.equal(f.calls.filter((sql) => sql.startsWith("delete")).length, 1);
  assert.ok(
    !f.calls.some((sql) =>
      /^(?:delete from|update|insert into) "(?:notes|note_revisions|chat_messages|projects)"/.test(
        sql,
      ),
    ),
  );
  assert.deepEqual(f.remaining, []);
});

for (const operation of ["createTask", "updateTask", "deleteTask"] as const) {
  test(`${operation} hides statement/commit failures and missing RETURNING rows`, async () => {
    for (const stage of ["statement", "commit", "missing"] as const) {
      const mutation: Step = {
        sql:
          operation === "createTask"
            ? /insert into "tasks"/
            : operation === "updateTask"
              ? /update "tasks"/
              : /delete from "tasks"/,
        rows:
          stage === "missing" ? [] : operation === "deleteTask" ? [[taskId, projectId]] : [row()],
        ...(stage === "statement" ? { error: new Error("secret postgres failure") } : {}),
      };
      const f = fixture([
        begin,
        operation === "createTask" ? project : lock(),
        mutation,
        ...(stage === "commit"
          ? [{ ...commit, error: new Error("secret postgres commit") }, rollback]
          : [stage === "missing" || stage === "statement" ? rollback : commit]),
      ]);
      failed(
        await f.service[operation](validInputs[operation]),
        stage === "missing" && operation !== "createTask" ? "CONFLICT" : "UNAVAILABLE",
      );
      assert.deepEqual(f.remaining, []);
    }
  });
}

test("task read/session failures use existing safe errors", async () => {
  const f = fixture([{ sql: /select/, error: new Error("secret postgres SELECT") }]);
  failed(await f.service.listOwnedTasks(), "UNAVAILABLE");
  assert.deepEqual(f.remaining, []);
  const service = createWorkspaceService({
    db: createDb({ DATABASE_URL: "postgresql://unused@127.0.0.1:1/unused" }),
    getSession: async () => {
      throw new Error("secret");
    },
  });
  failed(await service.getTask({ taskId }), "UNAVAILABLE");
});

test("task Server Actions remain thin, revalidate successful confirmed mutation views, and add no unfinished routes", () => {
  const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  for (const operation of ["createTask", "updateTask", "deleteTask"])
    assert.match(
      source,
      new RegExp(
        `export async function ${operation}\\(input: unknown\\) \\{\\s*const result = await workspace\\.${operation}\\(input\\);\\s*if \\(result\\.ok\\) refreshProjectViews\\(result\\.data\\.projectId\\);\\s*return result;`,
      ),
    );
  for (const operation of ["getTask", "listTasks", "listOwnedTasks"])
    assert.ok(source.includes(`return workspace.${operation}(input)`));
});
