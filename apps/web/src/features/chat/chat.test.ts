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
  let sessionUserId = userId;
  const service = createChatService({
    db,
    getSession: async () => {
      sessionCalls++;
      return sessionUserId ? { user: { id: sessionUserId } } : null;
    },
  });
  return {
    service,
    calls,
    remaining,
    assertionErrors,
    sessionCalls: () => sessionCalls,
    expireSession: () => {
      sessionUserId = null;
    },
  };
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
  () => service.renameConversation({ conversationId, title: "Renamed" }),
  () => service.deleteConversation({ conversationId }),
  () => service.getConversation({ conversationId }),
  () => service.getNoteProposal({ proposalId: projectId }),
  () =>
    service.completeProposal({
      ...turnInput,
      content: contracts.PROPOSAL_MESSAGE,
      draft: { projectHint: null, title: "Draft", content: "Original", noteDate: null },
    }),
  () => service.beginTurn(beginInput),
  () => service.completeResponse({ ...turnInput, content: "Answer" }),
  () => service.failResponse(turnInput),
  () => service.stopResponse(turnInput),
  () => service.recoverAbandonedTurn(turnInput),
  () => service.getGenerationContext(turnInput),
];

const sourceNoteId = "77777777-7777-4777-8777-777777777777";
const sourceRefs: contracts.SourceRef[] = [
  { noteId: sourceNoteId, projectId, retrievedUpdatedAt: now.toISOString() },
];
const sourceLock: Step = { ...lock, rows: [[conversationId, projectId, "Project chat", now, now]] };
const referencedRow = (refs: unknown = sourceRefs, status = "completed") => [
  ...messageRow("assistant", status, "Answer"),
  refs,
];
const sourceRead = (
  rows: unknown[][] = [[sourceNoteId, projectId, "Current authorized title", now]],
): Step => ({
  sql: /from "notes" inner join "projects"/,
  rows: rows.map((row) => [...row, "Authorized project"]),
  inspect: (sql, params) => {
    assert.match(sql, /"notes"\."id" in \(/);
    assert.match(sql, /"notes"\."project_id" = \$/);
    assert.match(sql, /"projects"\."owner_id" = \$/);
    assert.ok(
      params.includes("user-a") && params.includes(projectId) && params.includes(sourceNoteId),
    );
    assert.doesNotMatch(sql, /"content"|"excerpt"/);
  },
});

test("rename validates and locks an owned Main Chat, changing only title without activity drift", async () => {
  const f = fixture([
    begin,
    lock,
    {
      sql: /^update "chat_conversations" set "title" = \$.*"updated_at" = "chat_conversations"\."updated_at"/,
      rows: [[conversationId, null, "Renamed", now, now]],
      inspect: (text, params) => {
        scoped(text, params);
        assert.ok(params.includes(conversationId) && params.includes("Renamed"));
        assert.doesNotMatch(text, /set "project_id"|set "owner_id"/);
        assert.ok(!params.some((p) => p instanceof Date || p === now.toISOString()));
      },
    },
    commit,
  ]);
  const renamed = data(
    await f.service.renameConversation({ conversationId, title: "  Renamed  " }),
  );
  assert.equal(renamed.title, "Renamed");
  assert.equal(renamed.id, conversationId);
  assert.equal(renamed.projectId, null);
  assert.equal(renamed.updatedAt.getTime(), now.getTime());
  exhausted(f);
  f.expireSession();
  failure(await f.service.deleteConversation({ conversationId }), "UNAUTHENTICATED");
  assert.equal(f.sessionCalls(), 2);
});

test("management rejects invalid IDs/titles, caller authority and non-Main scopes without child writes", async () => {
  for (const input of [
    { conversationId: "invalid", title: "T" },
    { conversationId, title: " " },
    { conversationId, title: "x".repeat(301) },
    { conversationId, title: "bad\0title" },
    { conversationId, title: "\ud800" },
    { conversationId, title: "T", ownerId: "user-b" },
    { conversationId, title: "T", projectId },
  ]) {
    const f = fixture();
    failure(await f.service.renameConversation(input), "INVALID_INPUT");
    assert.equal(f.calls.length, 0);
  }
  for (const input of [
    { conversationId: "invalid" },
    { conversationId, ownerId: "user-b" },
    { conversationId, force: true },
  ]) {
    const f = fixture();
    failure(await f.service.deleteConversation(input), "INVALID_INPUT");
    assert.equal(f.calls.length, 0);
  }
  for (const method of ["renameConversation", "deleteConversation"] as const) {
    for (const rows of [[], [[conversationId, projectId, "Legacy project chat", now, now]]]) {
      const f = fixture([begin, { ...lock, rows }, rollback]);
      failure(
        await f.service[method]({
          conversationId,
          ...(method === "renameConversation" ? { title: "T" } : {}),
        }),
        "NOT_FOUND",
      );
      exhausted(f);
      assert.ok(!f.calls.some((s) => /^(delete|update|insert)/.test(s)));
    }
  }
});

test("a second account cannot rename or delete the first account's Main Chat", async () => {
  for (const method of ["renameConversation", "deleteConversation"] as const) {
    const f = fixture(
      [
        begin,
        {
          ...lock,
          rows: [],
          inspect: (text, params) => {
            assert.match(text, /"chat_conversations"\."owner_id" = \$/);
            assert.ok(params.includes("user-b") && params.includes(conversationId));
            assert.ok(!params.includes("user-a"));
          },
        },
        rollback,
      ],
      "user-b",
    );
    const result = await f.service[method]({
      conversationId,
      ...(method === "renameConversation" ? { title: "T" } : {}),
    });
    failure(result, "NOT_FOUND");
    assert.doesNotMatch(JSON.stringify(result), /user-a|createdAt|projectId|title/);
    exhausted(f);
  }
});

const deleteProposals: Step = {
  sql: /^delete from "note_proposals" where exists \(select .*from "chat_messages"/,
  inspect: (text, params) => {
    messageScoped(text, params);
    assert.match(text, /"chat_messages"\."id" = "note_proposals"\."source_message_id"/);
    assert.doesNotMatch(text, /"note_id"|"approved_project_id"|"status"/); // Both proposed and confirmed receipts, not notes.
  },
};
const deleteMessages: Step = { sql: /^delete from "chat_messages"/, inspect: messageScoped };
const deleteThread: Step = {
  sql: /^delete from "chat_conversations".*returning/,
  rows: [[conversationId]],
  inspect: scoped,
};

test("permanent delete orders proposals, messages, conversation in one owned transaction; notes/revisions are untouched", async () => {
  const f = fixture([
    begin,
    lock,
    pending(),
    deleteProposals,
    deleteMessages,
    deleteThread,
    commit,
  ]);
  assert.deepEqual(data(await f.service.deleteConversation({ conversationId })), {
    id: conversationId,
  });
  exhausted(f);
  assert.equal(f.calls[0], "begin isolation level read committed");
  assert.equal(f.calls.filter((s) => s.startsWith("delete")).length, 3);
  assert.ok(
    !f.calls.some((s) => /^(delete from|update|insert into) "(notes|note_revisions)"/.test(s)),
  );
  assert.equal(f.sessionCalls(), 1);
});

test("any pending response, even abandoned, blocks deletion before destructive statements", async () => {
  for (const created of [now, new Date(now.getTime() - PENDING_TIMEOUT_MS * 2)]) {
    const f = fixture([
      begin,
      lock,
      pending([messageRow("assistant", "pending", "", turnId, created)]),
      rollback,
    ]);
    failure(await f.service.deleteConversation({ conversationId }), "CONFLICT");
    exhausted(f);
    assert.ok(!f.calls.some((s) => s.startsWith("delete")));
  }
});

test("delete and rename failures request rollback and hide SQL/provider/driver details", async () => {
  const steps = [deleteProposals, deleteMessages, deleteThread, commit];
  for (let index = 0; index < steps.length; index++) {
    const f = fixture([
      begin,
      lock,
      pending(),
      ...steps.slice(0, index),
      { ...steps[index]!, error: new Error("private SQL credential sentinel") },
      rollback,
    ]);
    const result = await f.service.deleteConversation({ conversationId });
    failure(result, "UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(result), /private|credential|sentinel|SQL/);
    exhausted(f);
  }
  const lost = fixture([
    begin,
    lock,
    pending(),
    deleteProposals,
    deleteMessages,
    { ...deleteThread, rows: [] },
    rollback,
  ]);
  failure(await lost.service.deleteConversation({ conversationId }), "NOT_FOUND");
  exhausted(lost);
  const rename = fixture([
    begin,
    lock,
    { sql: /^update "chat_conversations"/, error: new Error("private SQL") },
    rollback,
  ]);
  failure(await rename.service.renameConversation({ conversationId, title: "T" }), "UNAVAILABLE");
  exhausted(rename);
});

// Real Drizzle statements over a staged transaction/mutex simulator. It checks
// application ordering/rollback decisions, NOT PostgreSQL locks, FKs or MVCC.
function deleteFixture(failAt?: string) {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  type Records = {
    conversation: boolean;
    pending: boolean;
    messages: number;
    proposals: number;
    notes: number;
    revisions: number;
  };
  let stored: Records = {
    conversation: true,
    pending: false,
    messages: 2,
    proposals: 2,
    notes: 1,
    revisions: 2,
  };
  let gate = Promise.resolve();
  let unlock: (() => void) | undefined;
  let waited = false;
  const calls: string[] = [];
  db.$client.connect = (async () => {
    let staged: Records | undefined;
    let release: (() => void) | undefined;
    return {
      on() {},
      off() {},
      release() {},
      async query(config: { text: string }) {
        const text = config.text;
        calls.push(text);
        if (text.startsWith("begin")) return { rows: [] };
        if (text.endsWith('for update of "chat_conversations"')) {
          waited = true;
          const before = gate;
          gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          await before;
          staged = { ...stored };
          return { rows: staged.conversation ? [conversationRow] : [] };
        }
        if (text === "rollback") {
          staged = undefined;
          release?.();
          return { rows: [] };
        }
        if (failAt && text.startsWith(failAt)) throw new Error("Synthetic rollback fault");
        assert.ok(staged, "Every child operation must follow the owned conversation lock");
        let rows: unknown[][] = [];
        if (/^select .*from "chat_messages"/.test(text)) rows = staged.pending ? [["pending"]] : [];
        else if (text.startsWith('delete from "note_proposals"')) staged.proposals = 0;
        else if (text.startsWith('delete from "chat_messages"')) {
          assert.equal(staged.proposals, 0);
          staged.messages = 0;
        } else if (text.startsWith('delete from "chat_conversations"')) {
          assert.equal(staged.messages, 0);
          staged.conversation = false;
          rows = [[conversationId]];
        } else if (text === "commit") {
          stored = staged;
          staged = undefined;
          release?.();
        } else throw new Error(`Unexpected simulated statement ${text}`);
        return { rows, rowCount: rows.length };
      },
    };
  }) as unknown as typeof db.$client.connect;
  return {
    service: createChatService({ db, getSession: async () => ({ user: { id: "user-a" } }) }),
    stored: () => ({ ...stored }),
    calls,
    waited: () => waited,
    hold: () => {
      gate = new Promise<void>((resolve) => {
        unlock = resolve;
      });
    },
    releaseWriter: (patch: Partial<Records>) => {
      stored = { ...stored, ...patch };
      unlock?.();
    },
  };
}

test("simulated partial deletes and commit failures leave original chat, proposals, notes and revisions intact", async () => {
  for (const point of [
    'delete from "chat_messages"',
    'delete from "chat_conversations"',
    "commit",
  ]) {
    const f = deleteFixture(point);
    const original = f.stored();
    failure(await f.service.deleteConversation({ conversationId }), "UNAVAILABLE");
    assert.deepEqual(f.stored(), original);
    assert.equal(f.calls.at(-1), "rollback");
  }
});

test("delete waits for a simulated confirmation SHARE holder, then keeps its committed notes and revisions", async () => {
  const f = deleteFixture();
  f.hold();
  const deleting = f.service.deleteConversation({ conversationId });
  while (!f.waited()) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(!f.calls.some((s) => s.startsWith("delete")));
  f.releaseWriter({ notes: 2 }); // Existing confirmation commits before releasing its conversation lock.
  assert.deepEqual(data(await deleting), { id: conversationId });
  assert.deepEqual(f.stored(), {
    conversation: false,
    pending: false,
    messages: 0,
    proposals: 0,
    notes: 2,
    revisions: 2,
  });
  failure(await f.service.deleteConversation({ conversationId }), "NOT_FOUND");
});

test("delete rechecks pending work after waiting for a simulated begin writer", async () => {
  const f = deleteFixture();
  f.hold();
  const deleting = f.service.deleteConversation({ conversationId });
  while (!f.waited()) await new Promise((resolve) => setTimeout(resolve, 0));
  f.releaseWriter({ pending: true, messages: 4 });
  failure(await deleting, "CONFLICT");
  assert.equal(f.stored().messages, 4);
  assert.equal(f.stored().proposals, 2);
  assert.ok(!f.calls.some((s) => s.startsWith("delete")));
});

test("sources complete atomically with content/status/activity and expose only an authorized public projection", async () => {
  const f = fixture([
    begin,
    sourceLock,
    replay([messageRow()]),
    clock(),
    sourceRead(),
    {
      ...terminal("completed", "Answer"),
      rows: [referencedRow()],
      inspect: (sql, params) => {
        messageScoped(sql, params);
        assert.match(sql, /"content" = \$.*"status" = \$.*"source_refs" = \$/);
        assert.ok(params.includes(JSON.stringify(sourceRefs)));
        assert.ok(params.includes("Answer") && params.includes("completed"));
      },
    },
    touch,
    commit,
  ]);
  const result = data(
    await f.service.completeResponse({ ...turnInput, content: "Answer", sourceRefs }),
  );
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]!.state, "available");
  assert.deepEqual(result.sources[0], {
    ...sourceRefs[0],
    ordinal: 1,
    state: "available",
    projectName: "Authorized project",
    title: "Current authorized title",
    href: `/projects/${projectId}/notes/${sourceNoteId}`,
    updatedAt: now.toISOString(),
  });
  assert.ok(!("sourceRefs" in result));
  exhausted(f);
});

test("sources exact canonical completion replay never rewrites metadata or timestamps", async () => {
  const refs = [{ retrievedUpdatedAt: "2026-01-01T00:00:00Z", projectId, noteId: sourceNoteId }];
  const f = fixture([begin, sourceLock, replay([referencedRow(refs)]), sourceRead([]), commit]);
  const result = data(
    await f.service.completeResponse({ ...turnInput, content: "Answer", sourceRefs }),
  );
  assert.deepEqual(result.sources, [{ ordinal: 1, state: "unavailable" }]);
  assert.equal(result.updatedAt.getTime(), now.getTime());
  assert.ok(!f.calls.some((sql) => sql.startsWith("update")));
  exhausted(f);
  for (const changed of [
    null,
    [{ ...sourceRefs[0], retrievedUpdatedAt: "2026-01-02T00:00:00Z" }],
  ]) {
    const mismatch = fixture([begin, sourceLock, replay([referencedRow()]), rollback]);
    failure(
      await mismatch.service.completeResponse({
        ...turnInput,
        content: "Answer",
        sourceRefs: changed,
      }),
      "CONFLICT",
    );
    exhausted(mismatch);
  }
});

test("sources completion failures request rollback and never acknowledge saved references", async () => {
  for (const stage of ["update", "activity", "commit"]) {
    const error = new Error("synthetic private SQL or source payload");
    const update = { ...terminal("completed", "Answer"), rows: [referencedRow()] };
    const steps = [
      begin,
      sourceLock,
      replay([messageRow()]),
      clock(),
      sourceRead(),
      stage === "update" ? { ...update, error } : update,
      ...(stage === "update" ? [] : [stage === "activity" ? { ...touch, error } : touch]),
      ...(stage === "commit" ? [{ ...commit, error }] : []),
      rollback,
    ];
    const f = fixture(steps);
    const result = await f.service.completeResponse({
      ...turnInput,
      content: "Answer",
      sourceRefs,
    });
    failure(result, "UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(result), /synthetic|sourceRefs|sources|77777777/);
    exhausted(f);
  }
});

test("sources contracts reject malformed, duplicate, excessive or client/model-provided metadata", async () => {
  for (const refs of [
    [],
    {},
    [{ ...sourceRefs[0], href: "/invented" }],
    [{ ...sourceRefs[0], noteId: "invalid" }],
    [{ ...sourceRefs[0], retrievedUpdatedAt: "2026-02-30T00:00:00Z" }],
    [...sourceRefs, ...sourceRefs],
    Array.from({ length: 6 }, () => ({ ...sourceRefs[0], noteId: crypto.randomUUID() })),
  ]) {
    const f = fixture();
    failure(
      await f.service.completeResponse({ ...turnInput, content: "Answer", sourceRefs: refs }),
      "INVALID_INPUT",
    );
    assert.equal(f.calls.length, 0);
  }
  assert.equal(
    contracts.streamTurnInput.safeParse({ ...turnInput, content, sourceRefs }).success,
    false,
  );
  assert.equal(
    contracts.completeProposalInput.safeParse({
      ...turnInput,
      content,
      draft: { projectHint: null, title: "Draft", content: "Original", noteDate: null },
      sourceRefs,
    }).success,
    false,
  );
  const unauthenticated = fixture([], null);
  failure(
    await unauthenticated.service.completeResponse({ ...turnInput, content: "Answer", sourceRefs }),
    "UNAUTHENTICATED",
  );
  assert.equal(unauthenticated.calls.length, 0);
});

test("sources new completion rejects different project scope and unavailable notes before updating", async () => {
  const foreignScope = fixture([
    begin,
    { ...lock, rows: [[conversationId, nextTurnId, "Chat", now, now]] },
    replay([messageRow()]),
    clock(),
    rollback,
  ]);
  failure(
    await foreignScope.service.completeResponse({ ...turnInput, content: "Answer", sourceRefs }),
    "INVALID_INPUT",
  );
  exhausted(foreignScope);
  const unavailable = fixture([
    begin,
    sourceLock,
    replay([messageRow()]),
    clock(),
    sourceRead([]),
    rollback,
  ]);
  failure(
    await unavailable.service.completeResponse({ ...turnInput, content: "Answer", sourceRefs }),
    "NOT_FOUND",
  );
  exhausted(unavailable);
});

test("sources completed begin replay reauthorizes references without writes or repeated retrieval", async () => {
  const f = fixture([
    begin,
    sourceLock,
    replay([messageRow("user", "completed", content), referencedRow()]),
    clock(),
    { sql: /from "note_proposals"/ },
    sourceRead([]),
    commit,
  ]);
  const result = data(await f.service.beginTurn(beginInput));
  assert.equal(result.replayed, true);
  assert.deepEqual(result.assistant.sources, [{ ordinal: 1, state: "unavailable" }]);
  assert.deepEqual(result.user.sources, []);
  assert.ok(!("sourceRefs" in result.assistant));
  assert.ok(!f.calls.some((sql) => /^(insert|update)/.test(sql)));
  exhausted(f);
});

test("sources history batches authorization, retains ordinal gaps and binds metadata to exact paginated messages", async () => {
  const secondRef = { ...sourceRefs[0]!, noteId: nextTurnId };
  const row = referencedRow([...sourceRefs, secondRef]);
  const other = messageRow("assistant", "completed", "Unrelated answer", nextTurnId);
  other[0] = nextTurnId;
  const f = fixture([
    { sql: /^begin isolation level repeatable read read only$/ },
    { sql: /from "chat_conversations"/, rows: sourceLock.rows, inspect: scoped },
    {
      sql: /from "chat_messages".*order by/,
      rows: [row, other],
      inspect: (_sql, params) => assert.deepEqual(params.slice(-2), [10, 50]),
    },
    pending(),
    clock(),
    { sql: /from "note_proposals"/ },
    sourceRead([[nextTurnId, projectId, "Second note, now renamed", now]]),
    commit,
  ]);
  const view = data(
    await f.service.getConversation({ conversationId, latest: true, limit: 10, offset: 50 }),
  );
  assert.deepEqual(view.messages.find((message) => message.id === nextTurnId)!.sources, []);
  const sources = view.messages.find((message) => message.id === row[0])!.sources;
  assert.deepEqual(sources[0], { ordinal: 1, state: "unavailable" });
  assert.deepEqual(sources[1], {
    ...secondRef,
    ordinal: 2,
    state: "available",
    projectName: "Authorized project",
    title: "Second note, now renamed",
    href: `/projects/${projectId}/notes/${nextTurnId}`,
    updatedAt: now.toISOString(),
  });
  assert.ok(view.messages.every((message) => !("sourceRefs" in message)));
  assert.equal(f.calls.filter((sql) => sql.includes('from "notes"')).length, 1);
  exhausted(f);
});

test("sources corrupt stored JSON fails safely without partial trusted links", async () => {
  for (const refs of [
    {},
    [],
    [...sourceRefs, { ...sourceRefs[0], href: "private-corrupt-url" }],
    [{ ...sourceRefs[0], projectId: nextTurnId }],
  ]) {
    const f = fixture([begin, sourceLock, replay([referencedRow(refs)]), rollback]);
    const result = await f.service.completeResponse({
      ...turnInput,
      content: "Answer",
      sourceRefs,
    });
    // Well-formed but changed scope conflicts; malformed records are unavailable.
    failure(result, Array.isArray(refs) && refs.length === 1 ? "CONFLICT" : "UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(result), /private-corrupt|77777777|sourceRefs/);
    exhausted(f);
  }
  const history = fixture([
    begin,
    { sql: /from "chat_conversations"/, rows: sourceLock.rows },
    { sql: /from "chat_messages".*order by/, rows: [referencedRow({ invalid: "private" })] },
    pending(),
    clock(),
    { sql: /from "note_proposals"/ },
    rollback,
  ]);
  failure(await history.service.getConversation({ conversationId }), "UNAVAILABLE");
  exhausted(history);
});

const crossNoteId = "88888888-8888-4888-8888-888888888888";
const crossRefs: contracts.SourceRef[] = [
  ...sourceRefs,
  { noteId: crossNoteId, projectId: nextTurnId, retrievedUpdatedAt: now.toISOString() },
];
const crossRows = [
  [sourceNoteId, projectId, "Decision A", now, "Orion"],
  [crossNoteId, nextTurnId, "Decision B", now, "Vega"],
];
const crossSourceRead = (rows: unknown[][] = crossRows): Step => ({
  sql: /from "notes" inner join "projects"/,
  rows,
  inspect: (sql, params) => {
    assert.match(sql, /"projects"\."id" = "notes"\."project_id"/);
    assert.match(sql, /"projects"\."owner_id" = \$/);
    assert.match(sql, /"notes"\."id" in \(/);
    assert.match(sql, /"projects"\."name"/);
    assert.ok(
      params.includes("user-a") && params.includes(sourceNoteId) && params.includes(crossNoteId),
    );
    assert.doesNotMatch(sql, /"notes"\."project_id" = \$|"content"|"excerpt"/);
  },
});

test("sources general completion atomically accepts multiple owned projects and projects current names", async () => {
  const f = fixture([
    begin,
    lock,
    replay([messageRow()]),
    clock(),
    crossSourceRead(),
    {
      ...terminal("completed", "Answer"),
      rows: [referencedRow(crossRefs)],
      inspect: (sql, params) => {
        messageScoped(sql, params);
        assert.ok(params.includes(JSON.stringify(crossRefs)));
        assert.match(sql, /"source_refs" = \$/);
      },
    },
    touch,
    commit,
  ]);
  const result = data(
    await f.service.completeResponse({ ...turnInput, content: "Answer", sourceRefs: crossRefs }),
  );
  assert.deepEqual(
    result.sources.map((source) =>
      source.state === "available"
        ? [source.ordinal, source.projectId, source.projectName, source.href]
        : source,
    ),
    [
      [1, projectId, "Orion", `/projects/${projectId}/notes/${sourceNoteId}`],
      [2, nextTurnId, "Vega", `/projects/${nextTurnId}/notes/${crossNoteId}`],
    ],
  );
  assert.ok(!("sourceRefs" in result));
  exhausted(f);
});

test("sources general completion rejects inaccessible notes and incorrect owned note/project associations before any write", async () => {
  for (const rows of [
    [],
    [crossRows[1]!],
    [[sourceNoteId, nextTurnId, "Wrong parent", now, "Vega"], crossRows[1]!],
  ]) {
    const f = fixture([
      begin,
      lock,
      replay([messageRow()]),
      clock(),
      crossSourceRead(rows),
      rollback,
    ]);
    const result = await f.service.completeResponse({
      ...turnInput,
      content: "Answer",
      sourceRefs: crossRefs,
    });
    failure(result, "NOT_FOUND");
    assert.ok(!f.calls.some((sql) => /^(insert|update)/.test(sql)));
    assert.doesNotMatch(JSON.stringify(result), /Wrong parent|Orion|Vega|sourceRefs/);
    exhausted(f);
  }
});

test("sources general exact completion replay reauthorizes each project and never resurrects inaccessible references", async () => {
  const f = fixture([
    begin,
    lock,
    replay([referencedRow(crossRefs)]),
    crossSourceRead([crossRows[1]!]),
    commit,
  ]);
  const result = data(
    await f.service.completeResponse({ ...turnInput, content: "Answer", sourceRefs: crossRefs }),
  );
  assert.deepEqual(result.sources[0], { ordinal: 1, state: "unavailable" });
  assert.equal(result.sources[1]!.state, "available");
  if (result.sources[1]!.state === "available")
    assert.equal(result.sources[1]!.projectName, "Vega");
  assert.ok(!f.calls.some((sql) => /^(insert|update)/.test(sql)));
  exhausted(f);
  const changed = fixture([begin, lock, replay([referencedRow(crossRefs)]), rollback]);
  failure(
    await changed.service.completeResponse({
      ...turnInput,
      content: "Answer",
      sourceRefs: [...crossRefs].reverse(),
    }),
    "CONFLICT",
  );
  exhausted(changed);
});

test("sources general history preserves ordinals but hides foreign, deleted or moved note/project metadata", async () => {
  const f = fixture([
    { sql: /^begin isolation level repeatable read read only$/ },
    { sql: /from "chat_conversations"/, rows: [conversationRow], inspect: scoped },
    {
      sql: /from "chat_messages".*order by/,
      rows: [referencedRow(crossRefs)],
      inspect: (_sql, params) => assert.deepEqual(params.slice(-2), [10, 50]),
    },
    pending(),
    clock(),
    { sql: /from "note_proposals"/ },
    crossSourceRead([
      [sourceNoteId, nextTurnId, "Do not expose moved title", now, "Do not expose moved project"],
      crossRows[1]!,
    ]),
    commit,
  ]);
  const view = data(
    await f.service.getConversation({ conversationId, latest: true, limit: 10, offset: 50 }),
  );
  assert.deepEqual(view.messages[0]!.sources[0], { ordinal: 1, state: "unavailable" });
  assert.equal(view.messages[0]!.sources[1]!.state, "available");
  assert.doesNotMatch(JSON.stringify(view), /Do not expose|sourceRefs/);
  exhausted(f);
});

test("sources general history reauthorizes foreign references using the current account without revealing project names", async () => {
  const f = fixture(
    [
      begin,
      {
        sql: /from "chat_conversations"/,
        rows: [conversationRow],
        inspect: (_sql, params) =>
          assert.ok(params.includes("user-b") && !params.includes("user-a")),
      },
      { sql: /from "chat_messages".*order by/, rows: [referencedRow(crossRefs)] },
      { sql: /from "chat_messages".*"status" = \$.*limit \$/ },
      clock(),
      { sql: /from "note_proposals"/ },
      {
        sql: /from "notes" inner join "projects"/,
        inspect: (sql, params) => {
          assert.match(sql, /"projects"\."id" = "notes"\."project_id"/);
          assert.match(sql, /"projects"\."owner_id" = \$/);
          assert.ok(params.includes("user-b") && !params.includes("user-a"));
        },
      },
      commit,
    ],
    "user-b",
  );
  const view = data(await f.service.getConversation({ conversationId }));
  assert.deepEqual(view.messages[0]!.sources, [
    { ordinal: 1, state: "unavailable" },
    { ordinal: 2, state: "unavailable" },
  ]);
  assert.doesNotMatch(JSON.stringify(view), /Orion|Vega|sourceRefs|projectName/);
  exhausted(f);
});

test("sources general completed begin replay returns fresh cross-project projections without writes", async () => {
  const f = fixture([
    begin,
    lock,
    replay([messageRow("user", "completed", content), referencedRow(crossRefs)]),
    clock(),
    { sql: /from "note_proposals"/ },
    crossSourceRead(),
    commit,
  ]);
  const result = data(await f.service.beginTurn(beginInput));
  assert.equal(result.replayed, true);
  assert.deepEqual(
    result.assistant.sources.map((source) =>
      source.state === "available" ? source.projectName : null,
    ),
    ["Orion", "Vega"],
  );
  assert.ok(!f.calls.some((sql) => /^(insert|update)/.test(sql)));
  exhausted(f);
});

test("sources general commit failure requests rollback without confirming references", async () => {
  const f = fixture([
    begin,
    lock,
    replay([messageRow()]),
    clock(),
    crossSourceRead(),
    { ...terminal("completed", "Answer"), rows: [referencedRow(crossRefs)] },
    { ...touch, error: new Error("private project detail") },
    rollback,
  ]);
  const result = await f.service.completeResponse({
    ...turnInput,
    content: "Answer",
    sourceRefs: crossRefs,
  });
  failure(result, "UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result), /Orion|Vega|sourceRefs|private project/);
  exhausted(f);
});

test("sources project history still rejects stored cross-project references without projecting any metadata", async () => {
  const f = fixture([
    begin,
    { sql: /from "chat_conversations"/, rows: sourceLock.rows },
    { sql: /from "chat_messages".*order by/, rows: [referencedRow(crossRefs)] },
    pending(),
    clock(),
    { sql: /from "note_proposals"/ },
    rollback,
  ]);
  failure(await f.service.getConversation({ conversationId }), "UNAVAILABLE");
  assert.ok(!f.calls.some((sql) => sql.includes('from "notes"')));
  exhausted(f);
});

test("sources legacy NULL completion/replay remains source-free", async () => {
  const f = fixture([begin, lock, replay([referencedRow(null)]), commit]);
  const result = data(await f.service.completeResponse({ ...turnInput, content: "Answer" }));
  assert.deepEqual(result.sources, []);
  assert.ok(!("sourceRefs" in result));
  exhausted(f);
});

test("every chat operation requires a fresh server session before SQL", async () => {
  const f = fixture([], null);
  for (const call of operations(f.service)) failure(await call(), "UNAUTHENTICATED");
  assert.equal(f.calls.length, 0);
  assert.equal(f.sessionCalls(), operations(f.service).length);
});

test("session expiry after confirmed begin denies context and every terminal/recovery operation before SQL", async () => {
  const f = fixture([begin, lock, replay(), clock(), pending(), insertTurn, touch, commit]);
  assert.equal(data(await f.service.beginTurn(beginInput)).replayed, false);
  const before = f.calls.length;
  f.expireSession();
  for (const call of [
    () => f.service.getGenerationContext(turnInput),
    () => f.service.completeResponse({ ...turnInput, content: "Answer" }),
    () => f.service.failResponse(turnInput),
    () => f.service.stopResponse(turnInput),
    () => f.service.recoverAbandonedTurn(turnInput),
  ])
    failure(await call(), "UNAUTHENTICATED");
  assert.equal(f.calls.length, before);
  assert.equal(f.sessionCalls(), 6);
  exhausted(f);
});

test("begin and finalization explicitly use READ COMMITTED with message reads after the row lock", async () => {
  const mutationBegin: Step = { sql: /^begin isolation level read committed$/ };
  const f = fixture([mutationBegin, lock, replay(), clock(), pending(), insertTurn, touch, commit]);
  data(await f.service.beginTurn(beginInput));
  exhausted(f);
  const end = fixture([
    mutationBegin,
    lock,
    replay([messageRow()]),
    clock(),
    terminal("completed", "Answer"),
    touch,
    commit,
  ]);
  data(await end.service.completeResponse({ ...turnInput, content: "Answer" }));
  exhausted(end);
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

test("generation context is a bounded chronological set of completed owned pairs, without notes", async () => {
  const f = fixture([
    { sql: /^begin isolation level repeatable read read only$/ },
    { sql: /from "chat_conversations"/, rows: [conversationRow], inspect: scoped },
    {
      sql: /left\("context_user"\."content", 2000\).*left\("chat_messages"\."content", 2000\).*inner join "chat_messages" "context_user"/,
      rows: [
        ["Recent question", "Recent answer"],
        ["Earlier question", "Earlier answer"],
      ],
      inspect: (sql, params) => {
        messageScoped(sql, params);
        assert.match(sql, /"context_user"\."conversation_id" = "chat_messages"\."conversation_id"/);
        assert.match(sql, /"context_user"\."turn_id" = "chat_messages"\."turn_id"/);
        assert.match(sql, /"chat_messages"\."turn_id" <> \$/);
        assert.match(
          sql,
          /order by "chat_messages"\."created_at" desc, "chat_messages"\."id" desc limit \$/,
        );
        assert.equal(params.filter((p) => p === "completed").length, 2);
        assert.ok(params.includes("user"));
        assert.ok(params.includes("assistant"));
        assert.ok(params.includes(turnId));
        assert.equal(params.at(-1), 8);
        assert.doesNotMatch(sql, /"notes"|note_revisions/);
      },
    },
    commit,
  ]);
  const result = data(await f.service.getGenerationContext(turnInput));
  assert.equal(result.project, null);
  assert.deepEqual(
    result.turns.map((turn) => turn.user),
    ["Earlier question", "Recent question"],
  );
  exhausted(f);
});

test("generation context includes only authorized project metadata and rejects inaccessible scope", async () => {
  const f = fixture([
    begin,
    {
      sql: /from "chat_conversations"/,
      rows: [[conversationId, projectId, "Conversation", now, now]],
      inspect: scoped,
    },
    {
      sql: /select left\("name", 200\), left\("description", 1000\) from "projects"/,
      rows: [["Project", "Description"]],
      inspect: (sql, params) => {
        assert.match(sql, /"owner_id" = \$/);
        assert.deepEqual(params, [projectId, "user-a"]);
      },
    },
    { sql: /inner join "chat_messages" "context_user"/ },
    commit,
  ]);
  assert.deepEqual(data(await f.service.getGenerationContext(turnInput)).project, {
    name: "Project",
    description: "Description",
  });
  exhausted(f);
  const denied = fixture([begin, { sql: /from "chat_conversations"/, inspect: scoped }, rollback]);
  failure(await denied.service.getGenerationContext(turnInput), "NOT_FOUND");
  exhausted(denied);
  const invalid = fixture();
  failure(await invalid.service.getGenerationContext({ ...turnInput, projectId }), "INVALID_INPUT");
  assert.equal(invalid.calls.length, 0);
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

test("omitted listing scope remains all owned history, including historical project conversations", async () => {
  const f = fixture([
    {
      sql: /from "chat_conversations"/,
      rows: [conversationRow, [turnId, projectId, "Older project thread", now, now]],
      inspect: (sql, params) => {
        scoped(sql, params);
        assert.equal([...sql.matchAll(/"project_id" is null/g)].length, 1); // Only the existing ownership predicate.
        assert.deepEqual(params.slice(-1), [50]);
      },
    },
  ]);
  const result = data(await f.service.listConversations());
  assert.deepEqual(
    result.map((row) => row.projectId),
    [null, projectId],
  );
  exhausted(f);
  assert.equal(contracts.listConversationsInput.parse({}).projectId, undefined);
});

test("explicit null filters Main Chat in SQL before ordering and pagination without changing ownership", async () => {
  const f = fixture([
    {
      sql: /from "chat_conversations"/,
      rows: [conversationRow],
      inspect: (sql, params) => {
        scoped(sql, params);
        assert.match(
          sql.replace(/[()]/g, ""),
          /and "chat_conversations"\."project_id" is null order by "chat_conversations"\."updated_at" desc, "chat_conversations"\."id" desc limit \$\d+ offset \$/,
        );
        assert.deepEqual(params.slice(-2), [20, 40]);
        assert.ok(!params.includes(null));
      },
    },
  ]);
  assert.equal(
    data(await f.service.listConversations({ projectId: null, limit: 20, offset: 40 }))[0]!
      .projectId,
    null,
  );
  exhausted(f);
  assert.equal(contracts.listConversationsInput.parse({ projectId: null }).projectId, null);
});

test("Main Chat and all-history listing retain fresh account isolation and safe empty results", async () => {
  for (const scope of [{ projectId: null }, {}]) {
    const f = fixture(
      [
        {
          sql: /from "chat_conversations"/,
          inspect: (sql, params) => {
            assert.match(sql, /"chat_conversations"\."owner_id" = \$/);
            assert.match(sql, /"projects"\."owner_id" = \$/);
            assert.equal(params.filter((value) => value === "user-b").length, 2);
            assert.ok(!params.includes("user-a"));
          },
        },
      ],
      "user-b",
    );
    assert.deepEqual(data(await f.service.listConversations(scope)), []);
    f.expireSession();
    failure(await f.service.listConversations(scope), "UNAUTHENTICATED");
    assert.equal(f.sessionCalls(), 2);
    assert.equal(f.calls.length, 1);
    exhausted(f);
  }
});

test("both history scopes sanitize failures and reject caller identity overrides before SQL", async () => {
  for (const scope of [{ projectId: null }, {}]) {
    const f = fixture([
      { sql: /from "chat_conversations"/, error: new Error("private driver sentinel") },
    ]);
    const result = await f.service.listConversations(scope);
    failure(result, "UNAVAILABLE");
    assert.ok(!JSON.stringify(result).includes("private driver sentinel"));
    exhausted(f);
    const invalid = fixture();
    failure(
      await invalid.service.listConversations({ ...scope, ownerId: "user-b" }),
      "INVALID_INPUT",
    );
    assert.equal(invalid.calls.length, 0);
  }
});

test("latest project conversation lookup filters in SQL before stable ordering and limit one", async () => {
  const f = fixture([
    {
      sql: /from "chat_conversations"/,
      rows: [[conversationId, projectId, "Project conversation", now, now]],
      inspect: (sql, params) => {
        scoped(sql, params);
        assert.match(
          sql,
          /and \("chat_conversations"\."project_id" = \$\d+\)\) order by "chat_conversations"\."updated_at" desc, "chat_conversations"\."id" desc limit \$/,
        );
        assert.deepEqual(params.slice(-2), [projectId, 1]);
        assert.doesNotMatch(sql, /offset|\b(?:insert|update|delete)\s/i);
      },
    },
  ]);
  const result = await f.service.listConversations({ projectId, limit: 1, offset: 0 });
  exhausted(f);
  const rows = data(result);
  assert.equal(rows[0]!.projectId, projectId);
  assert.equal(f.calls.length, 1);
  assert.equal(f.sessionCalls(), 1);
  exhausted(f);
});

test("foreign, nonexistent and empty project history all return empty without writes or metadata", async () => {
  for (const id of [projectId, turnId, nextTurnId]) {
    const f = fixture([
      {
        sql: /from "chat_conversations"/,
        inspect: (sql, params) => {
          scoped(sql, params);
          assert.ok(params.includes(id));
        },
      },
    ]);
    assert.deepEqual(data(await f.service.listConversations({ projectId: id, limit: 1 })), []);
    assert.equal(f.calls.length, 1);
    exhausted(f);
  }
});

test("project history filter rejects malformed IDs, identity overrides and invalid bounds before SQL", async () => {
  const f = fixture();
  for (const input of [
    { projectId: "invalid" },
    { projectId: false },
    { projectId: [projectId] },
    { projectId, ownerId: "user-b" },
    { projectId, limit: 0 },
    { projectId, offset: -1 },
  ])
    failure(await f.service.listConversations(input), "INVALID_INPUT");
  assert.equal(f.calls.length, 0);
  const anonymous = fixture([], null);
  failure(await anonymous.service.listConversations({ projectId, limit: 1 }), "UNAUTHENTICATED");
  assert.equal(anonymous.calls.length, 0);
});

test("project lookup rechecks the session on every invocation and binds the current owner on both joins", async () => {
  const f = fixture([
    {
      sql: /from "chat_conversations"/,
      inspect: scoped,
    },
  ]);
  data(await f.service.listConversations({ projectId, limit: 1 }));
  f.expireSession();
  failure(await f.service.listConversations({ projectId, limit: 1 }), "UNAUTHENTICATED");
  assert.equal(f.sessionCalls(), 2);
  assert.equal(f.calls.length, 1);
  exhausted(f);
  const b = fixture(
    [
      {
        sql: /from "chat_conversations"/,
        inspect: (_sql, params) => {
          assert.equal(params.filter((value) => value === "user-b").length, 2);
          assert.ok(!params.includes("user-a"));
          assert.ok(params.includes(projectId));
        },
      },
    ],
    "user-b",
  );
  assert.deepEqual(data(await b.service.listConversations({ projectId, limit: 1 })), []);
  exhausted(b);
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

test("latest history pages query backwards with owned scope then return user/assistant chronological order", async () => {
  const f = fixture([
    begin,
    { sql: /from "chat_conversations"/, rows: [conversationRow], inspect: scoped },
    {
      sql: /order by "chat_messages"\."created_at" desc, "chat_messages"\."role" asc, "chat_messages"\."id" desc/,
      rows: [
        messageRow("assistant", "completed", "answer"),
        messageRow("user", "completed", content),
      ],
      inspect: (sql, params) => {
        messageScoped(sql, params);
        assert.deepEqual(params.slice(-2), [50, 50]);
      },
    },
    pending(),
    clock(),
    { sql: /from "note_proposals"/, rows: [] },
    commit,
  ]);
  const view = data(
    await f.service.getConversation({ conversationId, latest: true, limit: 50, offset: 50 }),
  );
  assert.deepEqual(
    view.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  exhausted(f);
  const invalid = fixture();
  failure(
    await invalid.service.getConversation({ conversationId, latest: "true" }),
    "INVALID_INPUT",
  );
  assert.equal(invalid.calls.length, 0);
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
      ...(status === "completed" ? [{ sql: /from "note_proposals"/, rows: [] }] : []),
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

const proposalId = "77777777-7777-4777-8777-777777777777";
const draft = {
  projectHint: null,
  title: "Draft title",
  content: "  Original note\n",
  noteDate: null,
};
const proposalInput = { ...turnInput, content: contracts.PROPOSAL_MESSAGE, draft };
const proposalRow = [
  proposalId,
  messageRow()[0],
  null,
  draft.title,
  draft.content,
  null,
  "proposed",
  null,
  null,
  conversationId,
  turnId,
  null,
  null,
];
const proposalRead: Step = {
  sql: /from "note_proposals"/,
  rows: [proposalRow],
  inspect: (sql, params) => {
    scoped(sql, params);
    assert.match(sql, /inner join "chat_messages"/);
    assert.ok(params.includes("assistant"));
    assert.ok(params.includes("completed"));
  },
};
const userSource: Step = {
  sql: /select "content" from "chat_messages"/,
  rows: [[content]],
  inspect: messageScoped,
};
const proposalInsert: Step = {
  sql: /^insert into "note_proposals"/,
  rows: [[proposalId]],
  inspect: (sql, params) => {
    assert.ok(params.includes(messageRow()[0]));
    assert.ok(params.includes(draft.content));
    assert.deepEqual(params, [messageRow()[0], null, draft.title, draft.content, null]);
    assert.match(sql, /\$5(?:, default){8}\)/);
  },
};

test("proposal completion commits assistant, one original draft and activity in one transaction, never a note", async () => {
  const f = fixture([
    begin,
    lock,
    replay([messageRow()]),
    userSource,
    clock(),
    terminal("completed", contracts.PROPOSAL_MESSAGE),
    proposalInsert,
    touch,
    commit,
  ]);
  const result = data(await f.service.completeProposal(proposalInput));
  assert.equal(result.proposal.id, proposalId);
  assert.equal(result.proposal.sourceMessageId, result.id);
  assert.deepEqual(result.proposal.draft, draft);
  assert.equal(result.proposal.receipt, null);
  assert.equal(result.proposal.scopedProject, null);
  assert.match(f.calls[0]!, /read committed/);
  assert.ok(!f.calls.some((sql) => sql.startsWith('insert into "notes"')));
  exhausted(f);
});

for (const stage of ["insert", "activity", "commit"]) {
  test(`proposal ${stage} failure requests rollback of both assistant and proposal without success`, async () => {
    const steps: Step[] = [
      begin,
      lock,
      replay([messageRow()]),
      userSource,
      clock(),
      terminal("completed", contracts.PROPOSAL_MESSAGE),
    ];
    if (stage === "insert")
      steps.push({ ...proposalInsert, error: new Error("private driver sentinel") });
    else {
      steps.push(proposalInsert);
      if (stage === "activity")
        steps.push({ ...touch, error: new Error("private driver sentinel") });
      else steps.push(touch, { ...commit, error: new Error("private commit sentinel") });
    }
    steps.push(rollback);
    const f = fixture(steps);
    const result = await f.service.completeProposal(proposalInput);
    failure(result, "UNAVAILABLE");
    assert.ok(!JSON.stringify(result).includes("sentinel"));
    assert.equal(f.calls.at(-1), "rollback");
    exhausted(f);
  });
}

test("proposal completion rechecks owned scoped project under share lock and rejects conflicting hints", async () => {
  const f = fixture([
    begin,
    { ...lock, rows: [[conversationId, projectId, "Chat", now, now]] },
    replay([messageRow()]),
    {
      sql: /select "name" from "projects".*for share/,
      rows: [["Owned project"]],
      inspect: (sql, params) => {
        assert.ok(params.includes("user-a"));
        assert.ok(params.includes(projectId));
      },
    },
    userSource,
    rollback,
  ]);
  failure(
    await f.service.completeProposal({
      ...proposalInput,
      draft: { ...draft, projectHint: "Another project" },
    }),
    "INVALID_INPUT",
  );
  assert.ok(!f.calls.some((sql) => /^(insert|update)/.test(sql)));
  exhausted(f);
});

test("proposal source/date/deadline/session denial never inserts actionable drafts", async () => {
  const foreign = fixture([begin, { ...lock, rows: [] }, rollback]);
  failure(await foreign.service.completeProposal(proposalInput), "NOT_FOUND");
  exhausted(foreign);
  const missingUser = fixture([
    begin,
    lock,
    replay([messageRow()]),
    { ...userSource, rows: [] },
    rollback,
  ]);
  failure(await missingUser.service.completeProposal(proposalInput), "NOT_FOUND");
  exhausted(missingUser);
  const invented = fixture([begin, lock, replay([messageRow()]), userSource, rollback]);
  failure(
    await invented.service.completeProposal({
      ...proposalInput,
      draft: { ...draft, noteDate: "2026-01-01" },
    }),
    "INVALID_INPUT",
  );
  exhausted(invented);
  const expired = fixture([
    begin,
    lock,
    replay([messageRow()]),
    userSource,
    clock(new Date(now.getTime() + PENDING_TIMEOUT_MS)),
    rollback,
  ]);
  failure(await expired.service.completeProposal(proposalInput), "CONFLICT");
  exhausted(expired);
  const session = fixture();
  session.expireSession();
  failure(await session.service.completeProposal(proposalInput), "UNAUTHENTICATED");
  assert.deepEqual(session.calls, []);
});

test("proposal terminal callback replay returns same identity without writes; changed draft conflicts", async () => {
  for (const changed of [false, true]) {
    const f = fixture([
      begin,
      lock,
      replay([messageRow("assistant", "completed", contracts.PROPOSAL_MESSAGE)]),
      proposalRead,
      changed ? rollback : commit,
    ]);
    const result = await f.service.completeProposal({
      ...proposalInput,
      draft: changed ? { ...draft, content: "Changed" } : draft,
    });
    if (changed) failure(result, "CONFLICT");
    else assert.equal(data(result).proposal.id, proposalId);
    assert.ok(!f.calls.some((sql) => /^(insert|update)/.test(sql)));
    exhausted(f);
  }
  for (const status of ["failed", "stopped"]) {
    const f = fixture([begin, lock, replay([messageRow("assistant", status)]), rollback]);
    failure(await f.service.completeProposal(proposalInput), "CONFLICT");
    exhausted(f);
  }
});

test("proposal read uses fresh session, owned source and read-only snapshot; foreign/missing IDs are indistinguishable", async () => {
  const f = fixture([{ sql: /begin.*read only/ }, proposalRead, commit]);
  const result = data(await f.service.getNoteProposal({ proposalId }));
  assert.equal(result.id, proposalId);
  assert.equal(f.sessionCalls(), 1);
  exhausted(f);
  for (const owner of ["user-a", "user-b"]) {
    const denied = fixture(
      [
        { sql: /begin.*read only/ },
        {
          sql: /from "note_proposals"/,
          rows: [],
          inspect: (sql, params) => {
            assert.match(sql, /"chat_conversations"\."owner_id" = \$/);
            assert.ok(params.includes(owner));
          },
        },
        rollback,
      ],
      owner,
    );
    failure(await denied.service.getNoteProposal({ proposalId }), "NOT_FOUND");
    exhausted(denied);
  }
});

test("history and same-turn replay recover the committed original proposal in a bounded read", async () => {
  const history = fixture([
    { sql: /begin.*read only/ },
    { sql: /from "chat_conversations"/, rows: [conversationRow] },
    {
      sql: /from "chat_messages".*order by/,
      rows: [messageRow("assistant", "completed", contracts.PROPOSAL_MESSAGE)],
    },
    pending(),
    clock(),
    {
      ...proposalRead,
      inspect: (sql, params) => {
        assert.match(sql, /"source_message_id" in \(/);
        assert.equal(params.filter((p) => p === messageRow()[0]).length, 1);
      },
    },
    commit,
  ]);
  assert.equal(
    data(await history.service.getConversation({ conversationId })).messages[0]!.proposal!.id,
    proposalId,
  );
  exhausted(history);
  const replayed = fixture([
    begin,
    lock,
    replay([
      messageRow("user", "completed", content),
      messageRow("assistant", "completed", contracts.PROPOSAL_MESSAGE),
    ]),
    clock(),
    proposalRead,
    commit,
  ]);
  assert.equal(data(await replayed.service.beginTurn(beginInput)).proposal!.id, proposalId);
  exhausted(replayed);
});

test("confirmed proposal reads revalidate note ownership and fixed scope without mutating receipts", async () => {
  const noteId = "88888888-8888-4888-8888-888888888888";
  for (const scenario of ["owned", "foreign-note", "scope-mismatch"]) {
    const row = [...proposalRow];
    row[6] = "confirmed";
    row[7] = noteId;
    row[8] = projectId;
    if (scenario === "scope-mismatch") {
      row[11] = nextTurnId;
      row[12] = "Owned source project";
    }
    const f = fixture([
      { sql: /begin.*read only/ },
      { ...proposalRead, rows: [row] },
      {
        sql: /from "notes" inner join "projects"/,
        rows: scenario === "foreign-note" ? [] : [[noteId]],
        inspect: (sql, params) => {
          assert.match(sql, /"projects"\."owner_id" = \$/);
          assert.deepEqual(params, [noteId, projectId, "user-a"]);
        },
      },
      scenario === "owned" ? commit : rollback,
    ]);
    const result = await f.service.getNoteProposal({ proposalId });
    if (scenario === "owned")
      assert.deepEqual(data(result).receipt, {
        noteId,
        projectId,
        href: `/projects/${projectId}/notes/${noteId}`,
      });
    else failure(result, "NOT_FOUND");
    assert.ok(!f.calls.some((sql) => /^(insert|update)/.test(sql)));
    exhausted(f);
  }
});

test("draft validation preserves content, requires nullable fields and never invents dates or project scope", () => {
  const valid = contracts.prepareNoteInput.parse({
    ...draft,
    title: "  Trim title  ",
    noteDate: "0001-01-01",
  });
  assert.equal(valid.title, "Trim title");
  assert.equal(valid.content, draft.content);
  assert.equal(contracts.proposalMatchesContext(valid, "Historical date 0001-01-01", null), true);
  assert.equal(contracts.proposalMatchesContext(valid, "Yesterday", null), false);
  assert.equal(
    contracts.proposalMatchesContext({ ...draft, projectHint: "Different" }, content, "Owned"),
    false,
  );
  assert.equal(
    contracts.proposalMatchesContext({ ...draft, projectHint: "owned" }, content, "Owned"),
    true,
  );
  for (const value of [
    { ...draft, projectHint: undefined },
    { ...draft, noteDate: undefined },
    { ...draft, noteDate: "2026-02-30" },
    { ...draft, noteDate: "0000-01-01" },
    { ...draft, projectId },
    { ...draft, title: "bad\u0000" },
    { ...draft, content: "bad\ud800" },
  ]) {
    assert.equal(contracts.prepareNoteInput.safeParse(value).success, false);
  }
});
