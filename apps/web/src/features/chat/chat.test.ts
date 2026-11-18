import assert from "node:assert/strict";
import { test } from "node:test";

import { createDb } from "@solyn/db";

import * as contracts from "./contracts";
import { createChatService, PENDING_TIMEOUT_MS } from "./service";

const conversationId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const turnId = "33333333-3333-4333-8333-333333333333";
const nextTurnId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-01-01T00:00:00Z");
const content = "  Original\n\nquestion  ";
const modelId = "test/model";
const conversationRow = [conversationId, null, "Conversation", now, now];
const messageRow = (
  role = "assistant",
  status = "pending",
  text = "",
  turn = turnId,
  createdAt = now,
) => [
  role === "user" ? "55555555-5555-4555-8555-555555555555" : "66666666-6666-4666-8666-666666666666",
  conversationId,
  turn,
  role,
  text,
  status,
  role === "user" ? null : modelId,
  createdAt,
  createdAt,
];
type Step = {
  sql: RegExp;
  rows?: unknown[][] | { now: Date }[];
  inspect?: (sql: string, params: unknown[]) => void;
  error?: Error;
};

// Scripted, non-network driver below the real Drizzle query builder. It proves
// SQL scoping/transaction control flow, not actual PostgreSQL enforcement.
function fixture(steps: Step[] = [], userId: string | null = "user-a") {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const remaining = [...steps];
  const calls: string[] = [];
  const assertionErrors: unknown[] = [];
  const query = async (config: { text: string }, params: unknown[] = []) => {
    calls.push(config.text);
    const step = remaining.shift();
    try {
      assert.ok(step, `Unexpected offline SQL: ${config.text}`);
      assert.match(config.text, step.sql);
      step.inspect?.(config.text, params);
    } catch (error) {
      assertionErrors.push(error);
      throw error;
    }
    if (step.error) throw step.error;
    return { rows: step.rows ?? [], rowCount: step.rows?.length ?? 0 };
  };
  db.$client.query = query as typeof db.$client.query;
  const client = { query, on() {}, off() {}, release() {} };
  db.$client.connect = (async () => client) as unknown as typeof db.$client.connect;
  let sessionCalls = 0;
  const service = createChatService({
    db,
    getSession: async () => {
      sessionCalls++;
      return userId ? { user: { id: userId } } : null;
    },
  });
  return { service, calls, remaining, assertionErrors, sessionCalls: () => sessionCalls };
}
function scoped(sql: string, params: unknown[]) {
  assert.match(sql, /"chat_conversations"\."owner_id" = \$/);
  assert.match(sql, /"project_id" is null/);
  assert.match(sql, /or \(exists \(select/);
  assert.match(sql, /"projects"\."owner_id" = \$/);
  assert.ok(params.includes("user-a"));
}
function messageScoped(sql: string, params: unknown[]) {
  scoped(sql, params);
  assert.match(sql, /"chat_messages"\."conversation_id" = \$/);
  assert.match(sql, /exists \(select .* from "chat_conversations"/);
  assert.ok(params.includes(conversationId));
}
function failure(result: { ok: boolean; error?: { code: string } }, code: string) {
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, code);
}
function data<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected success");
  return result.data;
}
function exhausted(f: ReturnType<typeof fixture>) {
  assert.deepEqual(f.assertionErrors, []);
  assert.equal(f.remaining.length, 0);
}
const begin: Step = { sql: /^begin/ };
const commit: Step = { sql: /^commit/ };
const rollback: Step = { sql: /^rollback/ };
const lock: Step = {
  sql: /select .*from "chat_conversations".*for update of "chat_conversations"$/,
  rows: [conversationRow],
  inspect: scoped,
};
const clock = (value = now): Step => ({
  sql: /^select clock_timestamp\(\) as now$/,
  rows: [{ now: value }],
});
const replay = (rows: unknown[][] = []): Step => ({
  sql: /select .*from "chat_messages".*"turn_id" = \$/,
  rows,
  inspect: messageScoped,
});
const pending = (rows: unknown[][] = []): Step => ({
  sql: /select .*from "chat_messages".*"status" = \$.*limit \$/,
  rows,
  inspect: messageScoped,
});
const touch: Step = {
  sql: /^update "chat_conversations" set "updated_at" = \$/,
  rows: [[conversationId]],
  inspect: scoped,
};
const insertTurn: Step = {
  sql: /^insert into "chat_messages".*returning/,
  rows: [messageRow("user", "completed", content), messageRow()],
  inspect: (sql, params) => {
    assert.match(sql, /\), \(/); // One statement for both records inside the outer transaction.
    assert.equal(params.filter((p) => p === conversationId).length, 2);
    assert.equal(params.filter((p) => p === turnId).length, 2);
    assert.ok(params.includes(content));
    assert.ok(params.includes("user"));
    assert.ok(params.includes("completed"));
    assert.ok(params.includes("assistant"));
    assert.ok(params.includes("pending"));
    assert.ok(params.includes(modelId));
    // Database clock can equal the old activity timestamp; each new pair is
    // nevertheless strictly newer, with the same timestamp on both roles.
    const timestamps = [params[6], params[7], params[14], params[15]];
    assert.ok(timestamps.every((value) => value === timestamps[0]));
    assert.ok(new Date(timestamps[0] as string).getTime() > now.getTime());
  },
};
const terminal = (status: string, text = ""): Step => ({
  sql: /^update "chat_messages" set "content" = \$.*"status" = \$/,
  rows: [messageRow("assistant", status, text)],
  inspect: (sql, params) => {
    messageScoped(sql, params);
    assert.match(sql, /"role" = \$.*"status" = \$/);
    assert.ok(params.includes("assistant"));
    assert.ok(params.includes("pending"));
    assert.ok(params.includes(status));
    assert.ok(params.includes(text));
  },
});
const beginInput = { conversationId, turnId, content, modelId };
const turnInput = { conversationId, turnId };
const operations = (service: ReturnType<typeof createChatService>) => [
  () => service.createConversation({ title: "Conversation" }),
  () => service.listConversations(),
  () => service.getConversation({ conversationId }),
  () => service.beginTurn(beginInput),
  () => service.completeResponse({ ...turnInput, content: "Answer" }),
  () => service.failResponse(turnInput),
  () => service.stopResponse(turnInput),
  () => service.recoverAbandonedTurn(turnInput),
];

test("every chat operation requires a fresh server session before SQL", async () => {
  const f = fixture([], null);
  for (const call of operations(f.service)) failure(await call(), "UNAUTHENTICATED");
  assert.equal(f.calls.length, 0);
  assert.equal(f.sessionCalls(), 8);
});

test("strict validation bounds inputs and rejects identity, scope mutation and unsupported states", async () => {
  const f = fixture();
  for (const input of [
    { title: " " },
    { title: "x".repeat(301) },
    { title: "T", ownerId: "user-b" },
    { title: "T", projectId: "invalid" },
  ])
    failure(await f.service.createConversation(input), "INVALID_INPUT");
  for (const input of [
    { limit: 101 },
    { limit: 0 },
    { offset: -1 },
    { offset: 100_001 },
    { ownerId: "user-b" },
  ])
    failure(await f.service.listConversations(input), "INVALID_INPUT");
  for (const input of [
    { ...beginInput, content: " " },
    { ...beginInput, content: "x".repeat(100_001) },
    { ...beginInput, turnId: "bad" },
    { ...beginInput, modelId: " " },
    { ...beginInput, modelId: "x".repeat(201) },
    { ...beginInput, projectId },
    { ...beginInput, ownerId: "user-b" },
    { ...beginInput, role: "system" },
  ])
    failure(await f.service.beginTurn(input), "INVALID_INPUT");
  failure(await f.service.getConversation({ conversationId: "bad" }), "INVALID_INPUT");
  failure(await f.service.getConversation({ conversationId, limit: 101 }), "INVALID_INPUT");
  failure(await f.service.completeResponse({ ...turnInput, content: " " }), "INVALID_INPUT");
  failure(await f.service.failResponse({ ...turnInput, status: "completed" }), "INVALID_INPUT");
  failure(
    await f.service.stopResponse({ ...turnInput, content: "x".repeat(100_001) }),
    "INVALID_INPUT",
  );
  failure(
    await f.service.recoverAbandonedTurn({ ...turnInput, now: now.toISOString() }),
    "INVALID_INPUT",
  );
  assert.equal(f.calls.length, 0);
  assert.equal(contracts.beginTurnInput.parse(beginInput).content, content);
});

test("global conversation creation derives owner, normalizes title and keeps null scope", async () => {
  const f = fixture([
    begin,
    {
      sql: /^insert into "chat_conversations"/,
      rows: [conversationRow],
      inspect: (_sql, params) => {
        assert.ok(params.includes("user-a"));
        assert.ok(params.includes(null));
        assert.ok(params.includes("Conversation"));
      },
    },
    commit,
  ]);
  const result = data(await f.service.createConversation({ title: " Conversation " }));
  assert.equal(result.projectId, null);
  assert.ok(!("ownerId" in result));
  exhausted(f);
});

test("project conversation checks and locks the owned project before inserting fixed scope", async () => {
  const f = fixture([
    begin,
    {
      sql: /select .*from "projects".*for share$/,
      rows: [[projectId]],
      inspect: (sql, params) => {
        assert.match(sql, /"owner_id" = \$/);
        assert.deepEqual(params, [projectId, "user-a"]);
      },
    },
    {
      sql: /^insert into "chat_conversations"/,
      rows: [[conversationId, projectId, "Conversation", now, now]],
    },
    commit,
  ]);
  assert.equal(
    data(await f.service.createConversation({ projectId, title: "Conversation" })).projectId,
    projectId,
  );
  exhausted(f);
});

test("foreign and missing project scope are indistinguishable and never insert", async () => {
  for (const _kind of ["foreign", "missing"]) {
    const f = fixture([begin, { sql: /from "projects".*for share$/ }, rollback]);
    failure(await f.service.createConversation({ projectId, title: "T" }), "NOT_FOUND");
    exhausted(f);
    assert.equal(
      f.calls.some((sql) => sql.startsWith("insert")),
      false,
    );
  }
});

test("conversation listing is owner/project scoped, bounded and stably ordered", async () => {
  const f = fixture([
    {
      sql: /from "chat_conversations".*order by "chat_conversations"\."updated_at" desc, "chat_conversations"\."id" desc limit \$.*offset \$/,
      rows: [conversationRow],
      inspect: (sql, params) => {
        scoped(sql, params);
        assert.deepEqual(params.slice(-2), [100, 50]);
      },
    },
  ]);
  assert.equal(data(await f.service.listConversations({ limit: 100, offset: 50 })).length, 1);
  exhausted(f);
});

test("retrieval reads one coherent snapshot with ordered, paginated, owned messages and pending detection", async () => {
  const f = fixture([
    { sql: /^begin isolation level repeatable read read only$/ },
    { sql: /from "chat_conversations"/, rows: [conversationRow], inspect: scoped },
    {
      sql: /from "chat_messages".*order by "chat_messages"\."created_at" asc, "chat_messages"\."role" desc, "chat_messages"\."id" asc limit \$.*offset \$/,
      rows: [messageRow("user", "completed", content)],
      inspect: (sql, params) => {
        messageScoped(sql, params);
        assert.deepEqual(params.slice(-2), [10, 20]);
      },
    },
    pending([messageRow()]),
    clock(new Date(now.getTime() + PENDING_TIMEOUT_MS)),
    commit,
  ]);
  const result = data(await f.service.getConversation({ conversationId, limit: 10, offset: 20 }));
  assert.equal(result.messages.length, 1);
  assert.deepEqual(result.pendingTurn, { turnId, abandoned: true });
  assert.equal(
    f.calls.some((sql) => sql.startsWith("update")),
    false,
  );
  exhausted(f);
});

test("foreign or absent conversations deny direct reads before any message query", async () => {
  const f = fixture([begin, { sql: /from "chat_conversations"/, inspect: scoped }, rollback]);
  failure(await f.service.getConversation({ conversationId }), "NOT_FOUND");
  exhausted(f);
});

test("cross-user message mutations and begins are rejected before accessing messages", async () => {
  const methods = [
    "beginTurn",
    "completeResponse",
    "failResponse",
    "stopResponse",
    "recoverAbandonedTurn",
  ] as const;
  for (const method of methods) {
    const f = fixture([begin, { ...lock, rows: [] }, rollback]);
    failure(
      await f.service[method](beginInput),
      method === "beginTurn" ? "NOT_FOUND" : "INVALID_INPUT",
    );
    // Non-begin calls need their own strict payload, not begin-only modelId.
    if (method !== "beginTurn") {
      failure(
        await f.service[method]({
          ...turnInput,
          ...(method === "completeResponse" ? { content: "Answer" } : {}),
        }),
        "NOT_FOUND",
      );
    }
    exhausted(f);
    assert.equal(
      f.calls.some((sql) => sql.includes('from "chat_messages"')),
      false,
    );
  }
});

test("begin creates user/completed and assistant/pending in one transaction, then touches activity", async () => {
  const f = fixture([begin, lock, replay(), clock(), pending(), insertTurn, touch, commit]);
  const result = data(await f.service.beginTurn(beginInput));
  assert.equal(result.replayed, false);
  assert.equal(result.user.content, content);
  assert.equal(result.user.status, "completed");
  assert.equal(result.assistant.status, "pending");
  assert.equal(result.assistant.content, "");
  exhausted(f);
});

for (const status of ["pending", "completed", "failed", "stopped"]) {
  test(`same turn_id replay preserves ${status} records without inserts or restart`, async () => {
    const f = fixture([
      begin,
      lock,
      replay([messageRow("user", "completed", content), messageRow("assistant", status)]),
      clock(),
      commit,
    ]);
    const result = data(await f.service.beginTurn(beginInput));
    assert.equal(result.replayed, true);
    assert.equal(result.assistant.status, status);
    assert.equal(
      f.calls.some((sql) => /^(insert|update)/.test(sql)),
      false,
    );
    exhausted(f);
  });
}

test("replay with changed content/model conflicts; incomplete persisted pair fails closed", async () => {
  for (const [rows, code] of [
    [[messageRow("user", "completed", "Different"), messageRow()], "CONFLICT"],
    [
      [
        messageRow("user", "completed", content),
        [...messageRow().slice(0, 6), "other/model", now, now],
      ],
      "CONFLICT",
    ],
    [[messageRow()], "UNAVAILABLE"],
  ] as const) {
    const f = fixture([begin, lock, replay(rows.map((row) => [...row])), clock(), rollback]);
    failure(await f.service.beginTurn(beginInput), code);
    exhausted(f);
  }
});

test("a live pending turn blocks a different turn without writes", async () => {
  const f = fixture([begin, lock, replay(), clock(), pending([messageRow()]), rollback]);
  failure(await f.service.beginTurn(beginInput), "CONFLICT");
  exhausted(f);
});

for (const status of ["completed", "failed", "stopped"] as const) {
  test(`pending response can become ${status}; identical terminal callbacks are idempotent`, async () => {
    const method =
      status === "completed"
        ? "completeResponse"
        : status === "failed"
          ? "failResponse"
          : "stopResponse";
    const text = status === "completed" ? "Answer" : "Partial answer";
    const f = fixture([
      begin,
      lock,
      replay([messageRow()]),
      clock(),
      terminal(status, text),
      touch,
      commit,
    ]);
    assert.equal(data(await f.service[method]({ ...turnInput, content: text })).status, status);
    exhausted(f);
    const again = fixture([begin, lock, replay([messageRow("assistant", status, text)]), commit]);
    assert.equal(data(await again.service[method]({ ...turnInput, content: text })).content, text);
    exhausted(again);
    assert.equal(
      again.calls.some((sql) => sql.startsWith("update")),
      false,
    );
  });
}

test("missing/cross-conversation turn IDs do not update another message", async () => {
  for (const method of [
    "completeResponse",
    "failResponse",
    "stopResponse",
    "recoverAbandonedTurn",
  ] as const) {
    const f = fixture([begin, lock, replay(), rollback]);
    failure(
      await f.service[method]({
        ...turnInput,
        ...(method === "completeResponse" ? { content: "Answer" } : {}),
      }),
      "NOT_FOUND",
    );
    exhausted(f);
  }
});

test("terminal callbacks cannot overwrite final status/content or resurrect a stopped turn", async () => {
  for (const row of [
    messageRow("assistant", "stopped", "Partial"),
    messageRow("assistant", "completed", "Different"),
  ]) {
    const f = fixture([begin, lock, replay([row]), rollback]);
    failure(await f.service.completeResponse({ ...turnInput, content: "Answer" }), "CONFLICT");
    exhausted(f);
  }
});

test("failed/stopped responses may preserve empty or existing partial output", async () => {
  for (const status of ["failed", "stopped"] as const) {
    const method = status === "failed" ? "failResponse" : "stopResponse";
    for (const partial of ["", "Partial answer"]) {
      const f = fixture([
        begin,
        lock,
        replay([messageRow("assistant", "pending", partial)]),
        clock(),
        terminal(status, partial),
        touch,
        commit,
      ]);
      assert.equal(data(await f.service[method](turnInput)).content, partial);
      exhausted(f);
    }
  }
});

test("abandoned detection has an inclusive deadline, no read writes, and replay never reclaims generation", async () => {
  const f = fixture([
    begin,
    lock,
    replay([messageRow("user", "completed", content), messageRow()]),
    clock(new Date(now.getTime() + PENDING_TIMEOUT_MS)),
    commit,
  ]);
  const result = data(await f.service.beginTurn(beginInput));
  assert.equal(result.replayed, true);
  assert.equal(result.abandoned, true);
  exhausted(f);
});

test("explicit recovery fails only an abandoned pending turn and is safe to repeat", async () => {
  const f = fixture([
    begin,
    lock,
    replay([messageRow()]),
    clock(new Date(now.getTime() + PENDING_TIMEOUT_MS)),
    terminal("failed"),
    touch,
    commit,
  ]);
  assert.equal(data(await f.service.recoverAbandonedTurn(turnInput)).status, "failed");
  exhausted(f);
  const repeated = fixture([begin, lock, replay([messageRow("assistant", "failed")]), commit]);
  assert.equal(data(await repeated.service.recoverAbandonedTurn(turnInput)).status, "failed");
  exhausted(repeated);
  const active = fixture([
    begin,
    lock,
    replay([messageRow()]),
    clock(new Date(now.getTime() + PENDING_TIMEOUT_MS - 1)),
    rollback,
  ]);
  failure(await active.service.recoverAbandonedTurn(turnInput), "CONFLICT");
  exhausted(active);
});

test("late completion after deadline is rejected without changing pending history", async () => {
  const f = fixture([
    begin,
    lock,
    replay([messageRow()]),
    clock(new Date(now.getTime() + PENDING_TIMEOUT_MS)),
    rollback,
  ]);
  failure(await f.service.completeResponse({ ...turnInput, content: "Late answer" }), "CONFLICT");
  exhausted(f);
});

test("a new turn atomically retires an abandoned response before inserting the next pair", async () => {
  const f = fixture([
    begin,
    lock,
    replay(),
    clock(new Date(now.getTime() + PENDING_TIMEOUT_MS)),
    pending([messageRow()]),
    terminal("failed"),
    {
      ...insertTurn,
      rows: [
        messageRow("user", "completed", content, nextTurnId),
        messageRow("assistant", "pending", "", nextTurnId),
      ],
      inspect: (_sql, params) => {
        assert.equal(params.filter((p) => p === nextTurnId).length, 2);
        assert.ok(!params.includes(turnId));
      },
    },
    touch,
    commit,
  ]);
  assert.equal(
    data(await f.service.beginTurn({ ...beginInput, turnId: nextTurnId })).replayed,
    false,
  );
  exhausted(f);
});

test("all turn write failures request rollback and never report success or driver details", async () => {
  const secretError = new Error("postgresql://secret-password SQL private question");
  const sequences: Step[][] = [
    [begin, lock, replay(), clock(), pending(), { ...insertTurn, error: secretError }, rollback],
    [begin, lock, replay(), clock(), pending(), { ...insertTurn, rows: [messageRow()] }, rollback],
    [
      begin,
      lock,
      replay(),
      clock(),
      pending(),
      insertTurn,
      { ...touch, error: secretError },
      rollback,
    ],
    [
      begin,
      lock,
      replay(),
      clock(),
      pending(),
      insertTurn,
      touch,
      { ...commit, error: secretError },
      rollback,
    ],
    [
      begin,
      lock,
      replay(),
      clock(new Date(now.getTime() + PENDING_TIMEOUT_MS)),
      pending([messageRow()]),
      terminal("failed"),
      { ...insertTurn, error: secretError },
      rollback,
    ],
  ];
  for (const steps of sequences) {
    const f = fixture(steps);
    const result = await f.service.beginTurn(beginInput);
    failure(result, "UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(result), /secret-password|postgresql|SQL|private question/);
    exhausted(f);
  }
});

test("terminal update/touch failures roll back; lost pending guard fails closed", async () => {
  for (const steps of [
    [
      begin,
      lock,
      replay([messageRow()]),
      clock(),
      { ...terminal("completed", "Answer"), error: new Error("private SQL") },
      rollback,
    ],
    [
      begin,
      lock,
      replay([messageRow()]),
      clock(),
      terminal("completed", "Answer"),
      { ...touch, error: new Error("private SQL") },
      rollback,
    ],
  ]) {
    const f = fixture(steps);
    failure(await f.service.completeResponse({ ...turnInput, content: "Answer" }), "UNAVAILABLE");
    exhausted(f);
  }
  const lost = fixture([
    begin,
    lock,
    replay([messageRow()]),
    clock(),
    { ...terminal("completed", "Answer"), rows: [] },
    rollback,
  ]);
  failure(await lost.service.completeResponse({ ...turnInput, content: "Answer" }), "CONFLICT");
  exhausted(lost);
});

test("session/database failures return safe unavailable errors", async () => {
  const f = fixture([{ sql: /from "chat_conversations"/, error: new Error("private SQL") }]);
  failure(await f.service.listConversations(), "UNAVAILABLE");
  exhausted(f);
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  db.$client.query = () => {
    throw new Error("Must not query");
  };
  const service = createChatService({
    db,
    getSession: async () => {
      throw new Error("private auth failure");
    },
  });
  failure(await service.listConversations(), "UNAVAILABLE");
});

// A deterministic in-memory transaction/lock simulator under REAL Drizzle SQL.
// Separate clients wait at FOR UPDATE, see committed rows after lock acquisition,
// and publish staged inserts only at COMMIT. This is NOT a PostgreSQL lock test.
function concurrentFixture() {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  let committed: unknown[][] = [];
  let lockTail = Promise.resolve();
  let waiting = 0;
  db.$client.query = () => {
    throw new Error("Pool query bypassed transaction");
  };
  db.$client.connect = (async () => {
    let releaseLock: (() => void) | undefined;
    let staged: unknown[][] = [];
    const client = {
      on() {},
      off() {},
      release() {},
      async query(config: { text: string }, params: unknown[] = []) {
        const text = config.text;
        let rows: unknown[] = [];
        if (text.startsWith("begin")) {
          /* No data until the row lock. */
        } else if (text.endsWith('for update of "chat_conversations"')) {
          waiting++;
          const previous = lockTail;
          lockTail = new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
          await previous;
          staged = committed.map((row) => [...row]);
          rows = [conversationRow];
        } else if (text.startsWith("select clock_timestamp")) rows = [{ now }];
        else if (/^select .*from "chat_messages"/.test(text)) {
          assert.ok(releaseLock, "Messages must be read after locking");
          rows = /"turn_id" = \$/.test(text)
            ? staged.filter((row) => row[2] === params.at(-1))
            : staged.filter((row) => row[5] === "pending");
        } else if (text.startsWith('insert into "chat_messages"')) {
          assert.equal(params.length, 16);
          assert.equal(
            staged.some((row) => row[5] === "pending"),
            false,
          );
          rows = [0, 8].map((offset) => [
            crypto.randomUUID(),
            ...params.slice(offset, offset + 6),
            new Date(params[offset + 6] as string),
            new Date(params[offset + 7] as string),
          ]);
          staged.push(...(rows as unknown[][]));
        } else if (text.startsWith('update "chat_conversations"')) rows = [[conversationId]];
        else if (text.startsWith("commit")) {
          committed = staged;
          releaseLock?.();
        } else if (text.startsWith("rollback")) releaseLock?.();
        else throw new Error(`Unexpected simulator SQL: ${text}`);
        return { rows, rowCount: rows.length };
      },
    };
    return client;
  }) as unknown as typeof db.$client.connect;
  const service = createChatService({ db, getSession: async () => ({ user: { id: "user-a" } }) });
  return { service, rows: () => committed, waiting: () => waiting };
}

test("concurrent same-turn requests serialize: one new pair, one replay", async () => {
  const f = concurrentFixture();
  const results = await Promise.all([
    f.service.beginTurn(beginInput),
    f.service.beginTurn(beginInput),
  ]);
  assert.deepEqual(results.map((r) => data(r).replayed).sort(), [false, true]);
  assert.equal(f.rows().length, 2);
  assert.equal(f.waiting(), 2);
});

test("concurrent different turns serialize: one pending pair and one conflict", async () => {
  const f = concurrentFixture();
  const results = await Promise.all([
    f.service.beginTurn(beginInput),
    f.service.beginTurn({ ...beginInput, turnId: nextTurnId }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  failure(
    results.find((r) => !r.ok)!,
    "CONFLICT",
  );
  assert.equal(f.rows().length, 2);
  assert.equal(f.rows().filter((row) => row[5] === "pending").length, 1);
  assert.equal(f.waiting(), 2);
});
