import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
// Bun runtime built-ins only; the app intentionally has no Bun typings dependency.
const sqliteModule: string = "bun:sqlite";
const { Database: MemoryDatabase } = (await import(sqliteModule)) as {
  Database: new (path: string) => {
    exec(sql: string): void;
    query(sql: string): {
      run(...values: unknown[]): void;
      values(bindings: Record<string, unknown>): unknown[][];
    };
    close(): void;
  };
};
import { renderToStaticMarkup } from "react-dom/server";
import { createDb } from "@solyn/db";
import { createWorkspaceService } from "./service";
import { calendarDateOffset } from "./presentation";
import { localCalendarDate, taskFilters, taskPageHref } from "./task-state";
import { createSummaryReader, SummaryContent, type SummaryState } from "./workspace-summary";
import type { TaskOverview } from "./contracts";

const projectId = "11111111-1111-4111-8111-111111111111";
const foreignId = "22222222-2222-4222-8222-222222222222";
const id = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const ok = <T,>(data: T) => ({ ok: true as const, data });
const failure = { ok: false as const, error: { code: "UNAVAILABLE" as const, message: "safe" } };
// Execute the actual Drizzle-generated read SQL against isolated in-memory
// fixtures using Bun's built-in SQLite (no dependency/network/database target).
// SELECT FILTER, lexical date predicates and ordering match this subset of SQL;
// this is NOT PostgreSQL type/planner/MVCC/locking or authenticated browser proof.
function fixture(fail: number[] = []) {
  const memory = new MemoryDatabase(":memory:");
  memory.exec(`create table projects(id text primary key, owner_id text, name text);
    create table tasks(id text primary key, project_id text, title text, description text, status text, priority text, assignee text, due_date text, source_note_id text, version integer default 1, created_at text, updated_at text, completed_at text);
    insert into projects values('${projectId}','a','Owned'),('${foreignId}','b','Foreign');`);
  function add(n: number, due: string | null, status = "todo", project = projectId) {
    memory
      .query("insert into tasks(id,project_id,title,status,priority,due_date) values(?,?,?,?,?,?)")
      .run(id(n), project, `Task ${n}`, status, null, due);
  }
  add(1, "2026-12-31");
  add(2, "2027-01-01", "in_progress");
  add(3, "2027-01-07", "blocked");
  add(4, "2027-01-08");
  add(5, "2020-01-01", "done");
  add(6, null);
  add(7, null, "in_progress");
  add(8, "2026-12-31", "in_progress");
  add(9, "2027-01-03", "done");
  add(10, null, "done");
  add(11, "2020-01-01", "todo", foreignId);
  add(12, null, "in_progress", foreignId);
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const calls: { sql: string; params: unknown[] }[] = [];
  let user: string | null = "a";
  let sessions = 0;
  db.$client.query = (async (config: { text: string }, params: unknown[] = []) => {
    const index = calls.length;
    calls.push({ sql: config.text, params });
    assert.match(config.text, /"projects"\."owner_id" = \$/);
    assert.ok(params.includes(user));
    if (fail.includes(index)) throw new Error("private database credentials");
    const bindings = Object.fromEntries(params.map((p, i) => [`$${i + 1}`, p]));
    return { rows: memory.query(config.text).values(bindings), rowCount: 0 };
  }) as typeof db.$client.query;
  const service = createWorkspaceService({
    db,
    getSession: async () => {
      sessions++;
      return user ? { user: { id: user } } : null;
    },
  });
  return {
    service,
    calls,
    add,
    setUser: (value: string | null) => {
      user = value;
    },
    sessions: () => sessions,
    close: () => memory.close(),
  };
}
async function overview(f: ReturnType<typeof fixture>, today = "2027-01-01") {
  const result = await f.service.getTaskSummary({ today });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("failed");
  return result.data;
}

test("summary executes owner-scoped aggregate SQL with exact deadline boundaries and overlapping metrics", async () => {
  const f = fixture();
  try {
    const result = await overview(f);
    assert.deepEqual(result.counts, { overdue: 2, dueSoon: 2, inProgress: 3 });
    assert.equal(result.through, "2027-01-07");
    assert.deepEqual(
      result.attention?.map((t) => t.id),
      [id(1), id(8), id(2), id(3)],
    );
    assert.deepEqual(
      result.inProgress?.map((t) => t.id),
      [id(8), id(2), id(7)],
    );
    assert.ok(result.inProgress?.some((t) => t.dueDate === null));
    assert.ok(!result.attention?.some((t) => t.status === "done" || t.dueDate === null));
    assert.match(f.calls[0]!.sql, /count\(\*\) filter/);
    assert.doesNotMatch(f.calls[0]!.sql, /limit|offset/i);
    assert.match(f.calls[0]!.sql, /"due_date" < \$/);
    assert.match(f.calls[0]!.sql, /"due_date" >= \$/);
    assert.match(f.calls[0]!.sql, /"due_date" <= \$/);
    assert.ok(f.calls[0]!.params.includes("2027-01-01"));
    assert.ok(f.calls[0]!.params.includes("2027-01-07"));
    for (const call of f.calls.slice(1)) {
      assert.match(call.sql, /order by .*"due_date".*"tasks"\."id" limit \$/);
      assert.equal(call.params.at(-1), 5);
    }
    assert.match(f.calls[2]!.sql, /asc nulls last/);
  } finally {
    f.close();
  }
});

test("summary due-soon window includes leap day and both endpoints but excludes the seventh day", async () => {
  const f = fixture();
  try {
    f.add(20, "2028-02-28");
    f.add(21, "2028-02-29", "in_progress");
    f.add(22, "2028-03-02", "blocked");
    f.add(23, "2028-03-03");
    f.add(24, "2028-02-24");
    const result = await overview(f, "2028-02-25");
    assert.equal(result.through, "2028-03-02");
    assert.deepEqual(result.counts, { overdue: 6, dueSoon: 3, inProgress: 4 });
  } finally {
    f.close();
  }
});

test("summary aggregate counts exceed five-row preview bounds without truncating totals", async () => {
  const f = fixture();
  try {
    for (let i = 20; i < 40; i++) f.add(i, "2026-12-30");
    const result = await overview(f);
    assert.deepEqual(result.counts, { overdue: 22, dueSoon: 2, inProgress: 3 });
    assert.equal(result.attention?.length, 5);
    assert.deepEqual(
      result.attention?.map((t) => t.id),
      [20, 21, 22, 23, 24].map(id),
    );
    for (let i = 40; i < 50; i++) f.add(i, null, "in_progress");
    const active = await overview(f);
    assert.equal(active.counts?.inProgress, 13);
    assert.equal(active.inProgress?.length, 5);
  } finally {
    f.close();
  }
});

test("summary account switching and expiry use fresh sessions on every read; owner claims and invalid dates fail before SQL", async () => {
  const f = fixture();
  try {
    const a = await overview(f);
    assert.doesNotMatch(JSON.stringify(a), /Foreign/);
    f.setUser("b");
    const b = await overview(f);
    assert.deepEqual(b.counts, { overdue: 1, dueSoon: 0, inProgress: 1 });
    assert.ok(b.attention?.every((t) => t.projectId === foreignId));
    for (const input of [
      { today: "2027-02-29" },
      { today: "2027-01-01", ownerId: "a" },
      { today: "2027-01-01T00:00:00Z" },
      { today: "0000-01-01" },
      {},
    ]) {
      const before = f.calls.length;
      const denied = await f.service.getTaskSummary(input);
      assert.equal(denied.ok, false);
      if (!denied.ok) assert.equal(denied.error.code, "INVALID_INPUT");
      assert.equal(f.calls.length, before);
    }
    f.setUser(null);
    const before = f.calls.length;
    const denied = await f.service.getTaskSummary({ today: "2027-01-01" });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "UNAUTHENTICATED");
    assert.equal(f.calls.length, before);
    assert.equal(f.sessions(), 8);
  } finally {
    f.close();
  }
});

test("summary empty set is true zero while independent query failures remain unavailable, never fabricated zero", async () => {
  const empty = fixture();
  try {
    empty.setUser("c");
    const data = await overview(empty);
    assert.deepEqual(data.counts, { overdue: 0, dueSoon: 0, inProgress: 0 });
    assert.deepEqual(data.attention, []);
    assert.deepEqual(data.inProgress, []);
  } finally {
    empty.close();
  }
  for (const failures of [[0], [1], [2], [0, 1, 2]]) {
    const f = fixture(failures);
    try {
      const data = await overview(f);
      assert.equal(data.counts === null, failures.includes(0));
      assert.equal(data.attention === null, failures.includes(1));
      assert.equal(data.inProgress === null, failures.includes(2));
      assert.doesNotMatch(JSON.stringify(data), /credentials/);
    } finally {
      f.close();
    }
  }
});

test("calendar arithmetic handles leap days, month/year boundaries, DST periods and local rather than UTC dates", () => {
  for (const [today, end] of [
    ["2028-02-26", "2028-03-03"],
    ["2026-12-29", "2027-01-04"],
    ["2027-03-12", "2027-03-18"],
    ["0099-12-29", "0100-01-04"],
    ["9999-12-30", "9999-12-31"],
  ])
    assert.equal(calendarDateOffset(today!, 6), end);
  // Deterministic local-calendar accessors avoid depending on this runner's TZ.
  const local = { getFullYear: () => 2027, getMonth: () => 0, getDate: () => 1 } as Date;
  assert.equal(localCalendarDate(local), "2027-01-01");
});

test("summary links preserve incomplete/cutoff semantics through existing list filtering and pagination", async () => {
  const f = fixture();
  try {
    const filters = taskFilters({ status: "pending", overdueBefore: "2027-01-01" });
    assert.equal(filters.success, true);
    if (!filters.success) throw new Error("bad filter");
    const result = await f.service.listOwnedTasks(filters.data);
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.data.map((t) => t.id).sort(), [id(1), id(8)]);
    assert.match(taskPageHref("/tasks", filters.data, 50), /overdueBefore=2027-01-01/);
    assert.equal(taskFilters({ overdueBefore: "2027-02-29" }).success, false);
    const soon = await f.service.listOwnedTasks({
      status: "pending",
      dueDateFrom: "2027-01-01",
      dueDateTo: "2027-01-07",
    });
    assert.equal(soon.ok, true);
    if (soon.ok) assert.deepEqual(soon.data.map((t) => t.id).sort(), [id(2), id(3)]);
  } finally {
    f.close();
  }
});

const data: TaskOverview = {
  today: "2027-01-01",
  through: "2027-01-07",
  counts: { overdue: 23, dueSoon: 4, inProgress: 7 },
  attention: [
    {
      id: id(1),
      projectId,
      projectName: "Owned",
      title: "<script>unsafe</script>",
      status: "blocked",
      priority: "urgent",
      dueDate: "2026-12-31",
    },
  ],
  inProgress: [
    {
      id: id(7),
      projectId,
      projectName: "Owned",
      title: "Active",
      status: "in_progress",
      priority: null,
      dueDate: null,
    },
  ],
};
const html = (state: SummaryState) =>
  renderToStaticMarkup(<SummaryContent state={state} retry={() => {}} />);
test("summary SSR has stable loading placeholders, bounded canonical links and responsive empty/partial/error/retry states", () => {
  const loading = html({ loading: true, data: null });
  assert.match(loading, /Loading tasks/);
  assert.doesNotMatch(loading, /Unavailable|2027|No tasks/);
  const full = html({ loading: false, data });
  assert.match(full, /23/);
  assert.match(full, /Counts may overlap/);
  assert.match(full, /No deadline/);
  assert.match(full, /Overdue/);
  assert.match(full, /&lt;script&gt;/);
  assert.doesNotMatch(full, /<script>/);
  assert.match(full, new RegExp(`/tasks/${id(1)}`));
  assert.match(full, /status=pending&amp;overdueBefore=2027-01-01/);
  assert.match(full, /dueDateFrom=2027-01-01&amp;dueDateTo=2027-01-07/);
  assert.match(full, /view=tasks/);
  assert.match(full, /max-width:760px/);
  assert.match(full, /max-width:420px/);
  const empty = html({
    loading: false,
    data: {
      ...data,
      counts: { overdue: 0, dueSoon: 0, inProgress: 0 },
      attention: [],
      inProgress: [],
    },
  });
  assert.match(empty, /No overdue or upcoming tasks/);
  assert.match(empty, /No tasks in progress/);
  assert.doesNotMatch(empty, /Unavailable/);
  const partial = html({ loading: false, data: { ...data, counts: null, attention: null } });
  assert.match(partial, /Unavailable/);
  assert.match(partial, /Some task summary data is unavailable/);
  assert.match(partial, /Retry summary/);
  assert.match(partial, /Active/);
  assert.match(html({ loading: false, data: null, error: "UNAUTHENTICATED" }), /Sign in/);
  assert.match(
    html({ loading: false, data: null, error: "UNAVAILABLE" }),
    /Task summary unavailable/,
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("summary reader coalesces duplicate reads, rejects stale dates/late acknowledgements and clears links on failure", async () => {
  const states: SummaryState[] = [];
  const calls: unknown[] = [];
  const first = deferred<ReturnType<typeof ok<TaskOverview>>>();
  const second = deferred<ReturnType<typeof ok<TaskOverview>>>();
  const reader = createSummaryReader(
    async (input) => {
      calls.push(input);
      return calls.length === 1 ? first.promise : second.promise;
    },
    (state) => states.push(state),
  );
  const a = reader.load(data.today);
  assert.equal(reader.load(data.today), a);
  await Promise.resolve();
  assert.equal(calls.length, 1);
  const b = reader.load("2027-01-02");
  second.resolve(ok({ ...data, today: "2027-01-02" }));
  await b;
  first.resolve(ok(data));
  await a;
  assert.equal(states.at(-1)?.data?.today, "2027-01-02");
  const retired = deferred<ReturnType<typeof ok<TaskOverview>>>();
  const stopped = createSummaryReader(
    async () => retired.promise,
    (state) => states.push(state),
  );
  const pending = stopped.load(data.today);
  stopped.cancel();
  const before = states.length;
  retired.resolve(ok(data));
  await pending;
  assert.equal(states.length, before);
  const failed = createSummaryReader(
    async () => failure,
    (state) => states.push(state),
  );
  await failed.load(data.today);
  assert.equal(states.at(-1)?.data, null);
  assert.equal(states.at(-1)?.error, "UNAVAILABLE");
  let throws = true;
  const thrown = createSummaryReader(
    () => {
      if (throws) throw new Error("private transport failure");
      return Promise.resolve(ok(data));
    },
    (state) => states.push(state),
  );
  await thrown.load(data.today);
  assert.equal(states.at(-1)?.error, "UNAVAILABLE");
  throws = false;
  await thrown.load(data.today);
  assert.equal(states.at(-1)?.data?.counts?.overdue, 23);
  const wrongDate = createSummaryReader(
    async () => ok(data),
    (state) => states.push(state),
  );
  await wrongDate.load("2027-01-02");
  assert.equal(states.at(-1)?.data, null);
  let succeeds = false;
  const retry = createSummaryReader(
    async () => (succeeds ? ok(data) : failure),
    (state) => states.push(state),
  );
  await retry.load(data.today);
  succeeds = true;
  await retry.load(data.today);
  assert.equal(states.at(-1)?.data?.counts?.overdue, 23);
});

test("dashboard-only summary preserves project collection, retries and New project; fresh RSC generation remounts the reader", () => {
  const screen = readFileSync(new URL("./projects-screen.tsx", import.meta.url), "utf8");
  assert.match(screen, /if \(!projects && !home\)/);
  assert.match(screen, /home \?\s*\(\s*<>/);
  assert.match(screen, /<WorkspaceSummary key=\{crypto.randomUUID\(\)\} read=\{getTaskSummary\}/);
  assert.match(screen, /initial=\{projects.map\(projectRow\)\}/);
  assert.match(screen, /New project/);
  const component = readFileSync(new URL("./workspace-summary.tsx", import.meta.url), "utf8");
  assert.match(component, /localCalendarDate\(\)/);
  assert.match(component, /setHours\(24, 0, 0, 50\)/);
  assert.match(component, /reader.cancel\(\)/);
});

test("actual action bodies revalidate dashboard only after successful manual and AI task confirmations; reads never revalidate", async () => {
  // Execute copied thin adapters without loading server credentials/Next runtime.
  // This checks action control flow, not Next's mounted RSC/cache behavior.
  const source = readFileSync(new URL("./actions.ts", import.meta.url), "utf8")
    .replace(/^import .*;\r?$/gm, "")
    .replace(/^export /gm, "");
  const { Bun } = globalThis as unknown as {
    Bun: {
      Transpiler: new (options: { loader: string }) => { transformSync(source: string): string };
    };
  };
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const paths: string[] = [];
  let result: unknown = failure;
  const methods = {
    createTask: async () => result,
    updateTask: async () => result,
    deleteTask: async () => result,
    confirmManagementProposal: async () => result,
    getTaskSummary: async () => result,
  };
  const actions = new Function(
    "workspace",
    "revalidatePath",
    `${js}; return {createTask,updateTask,deleteTask,confirmManagementProposal,getTaskSummary};`,
  )(methods, (path: string) => paths.push(path));
  for (const name of ["createTask", "updateTask", "deleteTask", "confirmManagementProposal"]) {
    paths.length = 0;
    result = failure;
    await actions[name]({});
    assert.equal(paths.length, 0);
    result =
      name === "confirmManagementProposal"
        ? ok({
            proposal: {
              receipt: {
                kind: "update_task",
                result: { state: "available", projectId, href: `/tasks/${id(1)}` },
              },
            },
          })
        : ok({ id: id(1), projectId });
    await actions[name]({});
    assert.ok(paths.includes("/dashboard"));
    assert.ok(paths.includes("/tasks"));
  }
  paths.length = 0;
  result = ok({
    proposal: {
      receipt: {
        kind: "create_tasks",
        results: [{ state: "available", projectId, href: `/tasks/${id(1)}` }],
      },
    },
  });
  await actions.confirmManagementProposal({});
  assert.ok(paths.includes("/dashboard"));
  paths.length = 0;
  result = ok(data);
  await actions.getTaskSummary({ today: data.today });
  assert.equal(paths.length, 0);
});
