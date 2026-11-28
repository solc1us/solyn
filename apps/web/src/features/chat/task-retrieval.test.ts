import assert from "node:assert/strict";
import { test } from "node:test";
import { createDb } from "@solyn/db";
import { createWorkspaceService } from "../workspace/service";
import { searchTasksInput } from "../workspace/contracts";
import {
  taskSearchResult,
  taskSearchOutput,
  taskSearchQuery,
  searchTasksToolInput,
  prepareTaskUpdate,
  prepareTaskUpdateInput,
} from "./task-retrieval";

const taskId = "11111111-1111-4111-8111-111111111111",
  projectId = "22222222-2222-4222-8222-222222222222";
const task = {
  id: taskId,
  projectId,
  projectName: "Orion",
  title: "Build",
  description: null,
  status: "todo" as const,
  priority: null,
  assignee: null,
  dueDate: null,
  version: 4,
};
const input = {
  title: null,
  projectName: null,
  status: null,
  priority: "any" as const,
  dueDateFrom: null,
  dueDateTo: null,
  overdueBefore: null,
};
const retrieval = () =>
  taskSearchResult.parse({ items: [task], truncated: false, ambiguousProject: false });
type Step = {
  sql: RegExp;
  rows?: unknown[][];
  inspect?: (sql: string, params: unknown[]) => void;
  error?: boolean;
};
function fixture(steps: Step[], user: string | null = "owner") {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const remaining = [...steps],
    errors: unknown[] = [],
    calls: string[] = [];
  const query = async (config: { text: string }, params: unknown[] = []) => {
    calls.push(config.text);
    const step = remaining.shift();
    try {
      assert.ok(step, config.text);
      assert.match(config.text, step.sql);
      step.inspect?.(config.text, params);
    } catch (error) {
      errors.push(error);
      throw error;
    }
    if (step!.error) throw new Error("private SQL sentinel");
    return { rows: step!.rows ?? [], rowCount: step!.rows?.length ?? 0 };
  };
  db.$client.query = query as typeof db.$client.query;
  db.$client.connect = (async () => ({
    query,
    on() {},
    off() {},
    release() {},
  })) as unknown as typeof db.$client.connect;
  const service = createWorkspaceService({
    db,
    getSession: async () => (user ? { user: { id: user } } : null),
  });
  return {
    service,
    calls,
    expire: () => {
      user = null;
    },
    done: () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(remaining, []);
    },
  };
}
const begin = { sql: /^begin isolation level repeatable read read only$/ },
  commit = { sql: /^commit$/ };
const owned = (sql: string, params: unknown[]) => {
  assert.match(sql, /"owner_id" = \$/);
  assert.ok(params.includes("owner"));
};

test("task search SQL applies literal title/project, pending, nullable priority and inclusive dates before the eleven-row lookahead", async () => {
  const f = fixture([
    begin,
    { sql: /from "projects".*limit \$/, rows: [[projectId]], inspect: owned },
    {
      sql: /from "tasks" inner join "projects"/,
      rows: [Object.values(task)],
      inspect: (sql, params) => {
        owned(sql, params);
        assert.match(sql, /left\("tasks"\."description", 160\)/);
        assert.match(sql, /"tasks"\."status" <> \$/);
        assert.match(sql, /"tasks"\."priority" is null/);
        assert.match(sql, /"tasks"\."due_date" >= \$/);
        assert.match(sql, /"tasks"\."due_date" <= \$/);
        assert.match(sql, /order by "tasks"\."updated_at" desc, "tasks"\."id" desc limit \$/);
        assert.ok(params.includes("%Build!%!_!!%"));
        assert.ok(params.includes("%Orion!_%"));
        assert.ok(params.includes("2026-01-01"));
        assert.ok(params.includes("2026-01-31"));
        assert.equal(params.at(-1), 11);
      },
    },
    commit,
  ]);
  const result = await f.service.searchTasks({
    title: "Build%_!",
    projectName: "Orion_",
    status: "pending",
    priority: null,
    dueDateFrom: "2026-01-01",
    dueDateTo: "2026-01-31",
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected success");
  assert.deepEqual(result.data, { items: [task], truncated: false, ambiguousProject: false });
  f.done();
});

test("task overdue uses strictly earlier date and excludes Done; scoped owner filters precede limit", async () => {
  const f = fixture([
    begin,
    {
      sql: /from "tasks"/,
      inspect: (sql, params) => {
        owned(sql, params);
        assert.match(sql, /"tasks"\."due_date" < \$/);
        assert.doesNotMatch(sql, /due_date.*(?:now\(|timezone|at time zone)/i);
        assert.match(sql, /"tasks"\."status" <> \$/);
        assert.ok(params.includes("done"));
        assert.ok(params.includes(projectId));
        assert.ok(params.includes("2026-03-01"));
      },
    },
    commit,
  ]);
  assert.deepEqual(await f.service.searchTasks({ projectId, overdueBefore: "2026-03-01" }), {
    ok: true,
    data: { items: [], truncated: false, ambiguousProject: false },
  });
  f.done();
});

test("task lookup flags task truncation and ambiguous project names, without fetching entire collections", async () => {
  const rows = Array.from({ length: 11 }, () =>
    Object.values({ ...task, id: crypto.randomUUID() }),
  );
  const f = fixture([
    begin,
    {
      sql: /from "projects".*limit \$/,
      rows: [[projectId], [taskId]],
      inspect: (_s, p) => assert.equal(p.at(-1), 2),
    },
    { sql: /from "tasks".*limit \$/, rows },
    commit,
  ]);
  const result = await f.service.searchTasks({ projectName: "Orion" });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected success");
  assert.equal(result.data.items.length, 10);
  assert.equal(result.data.truncated, true);
  assert.equal(result.data.ambiguousProject, true);
  f.done();
});

test("task retrieval denies anonymous/expired requests and strict invalid filters before SQL", async () => {
  const f = fixture([], null);
  assert.equal((await f.service.searchTasks({})).ok, false);
  f.done();
  const valid = fixture([]);
  for (const bad of [
    { ownerId: "foreign" },
    { status: "overdue" },
    { limit: 1000 },
    { offset: 1 },
    { title: "bad\0" },
    { dueDateFrom: "2026-02-30" },
    { overdueBefore: "0000-01-01" },
    { dueDateFrom: "2026-03-02", dueDateTo: "2026-03-01" },
  ])
    assert.equal(searchTasksInput.safeParse(bad).success, false);
  valid.expire();
  const denied = await valid.service.searchTasks({});
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "UNAUTHENTICATED");
  valid.done();
});

test("task retrieval SQL failures remain failure, never an empty collection or private error", async () => {
  const f = fixture([begin, { sql: /from "tasks"/, error: true }, { sql: /^rollback$/ }]);
  const result = await f.service.searchTasks({});
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /sentinel|postgres|select /i);
  f.done();
});

test("task search tool has closed nullable filters, fixed scope and explicit literal calendar-cutoff semantics", () => {
  assert.equal(
    taskSearchQuery(searchTasksToolInput.parse(input), projectId, "").projectId,
    projectId,
  );
  assert.throws(() => taskSearchQuery({ ...input, projectName: "Other" }, projectId, ""));
  assert.throws(() =>
    taskSearchQuery({ ...input, overdueBefore: "2026-03-01" }, null, "overdue today"),
  );
  assert.equal(
    taskSearchQuery({ ...input, overdueBefore: "2026-03-01" }, null, "Before local date 2026-03-01")
      .overdueBefore,
    "2026-03-01",
  );
  assert.equal(searchTasksToolInput.safeParse({ ...input, projectId }).success, false);
});

test("task model output contains ordinals rather than raw identity and bounds long result sets honestly", () => {
  const data = retrieval();
  const out = taskSearchOutput(data);
  assert.equal(out.items[0]!.ordinal, 1);
  assert.doesNotMatch(JSON.stringify(out), new RegExp(taskId + "|" + projectId));
  assert.equal(out.items[0]!.version, 4);
  assert.equal(out.status, "found");
  const big = taskSearchResult.parse({
    items: Array.from({ length: 10 }, () => ({
      ...task,
      id: crypto.randomUUID(),
      title: "T".repeat(300),
      description: "😀".repeat(160),
      assignee: "A".repeat(200),
      projectName: "P".repeat(200),
    })),
    truncated: false,
    ambiguousProject: false,
  });
  const bounded = taskSearchOutput(big);
  assert.ok(JSON.stringify(bounded).length < 8000);
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.items.length < 10);
  for (const bad of [
    { ...task, version: 0 },
    { ...task, dueDate: "2026-02-30" },
    { ...task, title: "bad\0" },
    { ...task, description: "x".repeat(161) },
  ])
    assert.equal(
      taskSearchResult.safeParse({ items: [bad], truncated: false, ambiguousProject: false })
        .success,
      false,
    );
  assert.equal(
    taskSearchResult.safeParse({ items: [task, task], truncated: false, ambiguousProject: false })
      .success,
    false,
  );
});

test("optional search filters default only to no restriction and never override fixed scope", () => {
  const parsed = searchTasksToolInput.parse({ status: "pending" });
  const query = taskSearchQuery(parsed, projectId, "");
  assert.deepEqual(
    Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined)),
    { projectId, status: "pending" },
  );
  assert.equal(taskSearchQuery(searchTasksToolInput.parse({}), null, "").priority, undefined);
  assert.equal(
    taskSearchQuery(searchTasksToolInput.parse({ priority: "none" }), null, "").priority,
    null,
  );
  assert.equal(
    taskSearchQuery(searchTasksToolInput.parse({ priority: "high" }), null, "").priority,
    "high",
  );
  for (const bad of [
    { ownerId: "other" },
    { projectId },
    { priority: null },
    { dueDateFrom: "2026-02-30" },
    { extra: true },
  ])
    assert.equal(searchTasksToolInput.safeParse(bad).success, false);
});

const providerUpdate = (changes: Record<string, unknown>) => ({
  ordinal: 1,
  fieldsToChange: Object.keys(changes),
  changes: {
    title: null,
    description: null,
    status: null,
    priority: null,
    assignee: null,
    dueDate: null,
    ...changes,
  },
});

test("provider field selection normalizes to partial changes, allows explicit clears and ignores every unselected value", () => {
  const selected = providerUpdate({ status: "done" });
  const payload = {
    ...selected,
    changes: { ...selected.changes, title: "Ignored title", dueDate: "2026-03-01" },
  }; // unselected values cannot mutate state or require new date evidence
  const draft = prepareTaskUpdate(payload, retrieval(), "done");
  assert.equal(draft.kind, "update_task");
  if (draft.kind === "update_task") assert.deepEqual(draft.changes, { status: "done" });
  const cleared = prepareTaskUpdate(
    providerUpdate({ description: null, priority: null, assignee: null, dueDate: null }),
    retrieval(),
    "clear",
  );
  if (cleared.kind === "update_task")
    assert.deepEqual(cleared.changes, {
      description: null,
      priority: null,
      assignee: null,
      dueDate: null,
    });
  for (const fieldsToChange of [
    [],
    ["status", "status"],
    ["sourceNoteId"],
    ["title"],
    ["status", "projectId"],
  ]) {
    const bad = { ...providerUpdate({ status: "done" }), fieldsToChange };
    assert.equal(prepareTaskUpdateInput.safeParse(bad).success, false);
  }
  assert.equal(prepareTaskUpdateInput.safeParse(providerUpdate({ status: null })).success, false);
  assert.equal(
    prepareTaskUpdateInput.safeParse({
      ordinal: 1,
      fieldsToChange: ["status"],
      changes: { status: "done" },
    }).success,
    false,
  );
});

test("update preparation derives current identity/version from a unique authorized ordinal and enforces partial changes", () => {
  const draft = prepareTaskUpdate(
    providerUpdate({ status: "done", description: null }),
    retrieval(),
    "Mark done",
  );
  assert.deepEqual(draft, {
    schemaVersion: 1,
    kind: "update_task",
    taskId,
    projectId,
    expectedVersion: 4,
    changes: { status: "done", description: null },
  });
  for (const changes of [
    {},
    { sourceNoteId: taskId },
    { projectId },
    { version: 5 },
    { completedAt: "now" },
    { title: null },
  ])
    assert.equal(prepareTaskUpdateInput.safeParse(providerUpdate(changes)).success, false);
  assert.throws(() =>
    prepareTaskUpdate({ ...providerUpdate({ status: "done" }), ordinal: 2 }, retrieval(), ""),
  );
  assert.throws(() =>
    prepareTaskUpdate(
      { ...providerUpdate({ status: "done" }), expectedVersion: 5 },
      retrieval(),
      "",
    ),
  );
  for (const data of [
    undefined,
    { ...retrieval(), truncated: true },
    { ...retrieval(), ambiguousProject: true },
    { ...retrieval(), items: [] },
    { ...retrieval(), items: [task, { ...task, id: projectId }] },
  ])
    assert.throws(() => prepareTaskUpdate(providerUpdate({ status: "done" }), data, ""));
  assert.throws(() =>
    prepareTaskUpdate(providerUpdate({ dueDate: "2026-03-01" }), retrieval(), "tomorrow"),
  );
  assert.doesNotThrow(() =>
    prepareTaskUpdate(providerUpdate({ dueDate: "2026-03-01" }), retrieval(), "Due 2026-03-01"),
  );
});
