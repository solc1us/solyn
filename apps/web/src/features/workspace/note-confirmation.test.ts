import assert from "node:assert/strict";
import { test } from "node:test";
import { createDb } from "@solyn/db";
import { createWorkspaceService } from "./service";

const proposalId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "33333333-3333-4333-8333-333333333333";
const noteId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-01-01T00:00:00Z");
const input = {
  proposalId,
  projectId,
  title: "  Approved title  ",
  content: "  Original\ncontent  ",
  noteDate: null,
};
const canonical = { ...input, title: input.title.trim() };
const receipt = [proposalId, "confirmed", noteId, projectId, canonical.title, input.content, null];
type Step = {
  sql: RegExp;
  rows?: unknown[][];
  error?: Error;
  inspect?: (sql: string, params: unknown[]) => void;
};
const begin: Step = { sql: /^begin isolation level read committed$/ };
const commit: Step = { sql: /^commit$/ };
const rollback: Step = { sql: /^rollback$/ };
const ownedSource = (sql: string, params: unknown[]) => {
  assert.match(sql, /"chat_conversations"\."owner_id" = \$/);
  assert.ok(params.includes("user-a"));
  assert.ok(params.includes("assistant"));
  assert.ok(params.includes("completed"));
  assert.ok(params.includes(proposalId));
};
const discovery: Step = {
  sql: /from "note_proposals".*inner join "chat_messages"/,
  rows: [[conversationId]],
  inspect: ownedSource,
};
const conversation: Step = {
  sql: /from "chat_conversations".*for share of "chat_conversations"$/,
  rows: [[conversationId, null]],
};
const proposal: Step = {
  sql: /from "note_proposals".*for update of "note_proposals"$/,
  rows: [[proposalId, "proposed", null, null, null, null, null]],
  inspect: ownedSource,
};
const project: Step = {
  sql: /from "projects".*for share$/,
  rows: [[projectId]],
  inspect: (sql, params) => {
    assert.match(sql, /"projects"\."owner_id" = \$/);
    assert.ok(params.includes("user-a"));
  },
};
const insert: Step = {
  sql: /^insert into "notes"/,
  rows: [[noteId, projectId, canonical.title, input.content, null, now, now]],
  inspect: (_sql, params) => {
    assert.deepEqual(params, [projectId, canonical.title, input.content, null]);
  },
};
const update: Step = {
  sql: /^update "note_proposals"/,
  rows: [[proposalId]],
  inspect: (sql, params) => {
    assert.match(sql, /"confirmed_at" = clock_timestamp\(\)/);
    assert.match(sql, /"status" = \$/);
    assert.doesNotMatch(sql, /"(?:title|content|note_date|source_message_id|created_at)" = /);
    assert.deepEqual(params, [
      "confirmed",
      noteId,
      projectId,
      canonical.title,
      input.content,
      null,
      proposalId,
      "proposed",
    ]);
  },
};
const noteRead: Step = {
  sql: /select "id" from "notes"/,
  rows: [[noteId]],
  inspect: (sql, params) => {
    assert.match(sql, /exists \(select/);
    assert.ok(params.includes("user-a"));
    assert.ok(params.includes(projectId));
    assert.ok(params.includes(noteId));
    assert.doesNotMatch(sql, /select .*"content"/); // Replay never compares mutable current content.
  },
};
function fixture(steps: Step[], user: string | null = "user-a") {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const remaining = [...steps],
    calls: string[] = [],
    errors: unknown[] = [];
  const query = async (config: { text: string }, params: unknown[] = []) => {
    calls.push(config.text);
    const step = remaining.shift();
    try {
      assert.ok(step, `Unexpected offline SQL: ${config.text}`);
      assert.match(config.text, step.sql);
      step.inspect?.(config.text, params);
    } catch (error) {
      errors.push(error);
      throw error;
    }
    if (step!.error) throw step!.error;
    return { rows: step!.rows ?? [], rowCount: step!.rows?.length ?? 0 };
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
      return user ? { user: { id: user } } : null;
    },
  });
  return {
    service,
    calls,
    expire: () => {
      user = null;
    },
    sessions: () => sessions,
    done: () => {
      assert.deepEqual(errors, []);
      assert.deepEqual(remaining, []);
    },
  };
}
function denied(result: { ok: boolean; error?: { code: string } }, code: string) {
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, code);
}
function success<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected success");
  return result.data;
}
const start = [begin, discovery, conversation, proposal];

test("confirmation requires a fresh session, including after an earlier successful save", async () => {
  const f = fixture([...start, project, insert, update, commit]);
  success(await f.service.confirmNoteProposal(input));
  f.expire();
  denied(await f.service.confirmNoteProposal(input), "UNAUTHENTICATED");
  assert.equal(f.sessions(), 2);
  f.done();
  const anonymous = fixture([], null);
  denied(await anonymous.service.confirmNoteProposal(input), "UNAUTHENTICATED");
  anonymous.done();
});
test("confirmation strict schema rejects identity/status/unknown fields, missing nullable date and unsafe text before SQL", async () => {
  const f = fixture([]);
  for (const value of [
    { ...input, ownerId: "user-b" },
    { ...input, status: "confirmed" },
    { ...input, noteId },
    { ...input, noteDate: undefined },
    { ...input, noteDate: "2026-02-30" },
    { ...input, content: "bad\u0000" },
    { ...input, title: "bad\ud800" },
    { ...input, title: " " },
    { ...input, content: " " },
    { ...input, projectId: "not-uuid" },
    { ...input, proposalId: "not-uuid" },
    { ...input, content: "x".repeat(100_001) },
  ]) {
    denied(await f.service.confirmNoteProposal(value), "INVALID_INPUT");
  }
  f.done();
});
test("confirmation atomically inserts one note and immutable receipt, canonicalizes UUID/title and preserves content", async () => {
  const f = fixture([...start, project, insert, update, commit]);
  const result = success(
    await f.service.confirmNoteProposal({ ...input, proposalId: proposalId.toUpperCase() }),
  );
  assert.deepEqual(result, {
    proposalId,
    noteId,
    projectId,
    href: `/projects/${projectId}/notes/${noteId}`,
    replayed: false,
  });
  assert.equal(f.calls.filter((s) => s.startsWith('insert into "notes"')).length, 1);
  assert.ok(
    !f.calls.some(
      (s) => s.includes("note_revisions") || s.startsWith('update "chat_conversations"'),
    ),
  );
  f.done();
});
test("authorized discovery, conversation lock and source recheck deny foreign/missing/incomplete sources", async () => {
  for (const steps of [
    [begin, { ...discovery, rows: [] }, rollback],
    [begin, discovery, { ...conversation, rows: [] }, rollback],
    [begin, discovery, conversation, { ...proposal, rows: [] }, rollback],
  ]) {
    const f = fixture(steps);
    denied(await f.service.confirmNoteProposal(input), "NOT_FOUND");
    f.done();
  }
});
test("foreign/missing final projects deny identically; owned but different scoped project conflicts", async () => {
  const foreign = fixture([...start, { ...project, rows: [] }, rollback]);
  denied(await foreign.service.confirmNoteProposal(input), "NOT_FOUND");
  foreign.done();
  for (const owned of [true, false]) {
    const f = fixture([
      begin,
      discovery,
      { ...conversation, rows: [[conversationId, otherProjectId]] },
      proposal,
      { ...project, rows: owned ? [[projectId]] : [] },
      rollback,
    ]);
    denied(await f.service.confirmNoteProposal(input), owned ? "CONFLICT" : "NOT_FOUND");
    f.done();
  }
  const scoped = fixture([
    begin,
    discovery,
    { ...conversation, rows: [[conversationId, projectId]] },
    proposal,
    project,
    insert,
    update,
    commit,
  ]);
  success(await scoped.service.confirmNoteProposal(input));
  scoped.done();
});
for (const stage of ["insert", "receipt", "missing-receipt", "commit"])
  test(`confirmation ${stage} failure requests whole-transaction rollback without success`, async () => {
    const failure = new Error("private-driver-sentinel");
    const steps = [...start, project];
    if (stage === "insert") steps.push({ ...insert, error: failure });
    else {
      steps.push(insert);
      if (stage === "receipt") steps.push({ ...update, error: failure });
      else if (stage === "missing-receipt") steps.push({ ...update, rows: [] });
      else steps.push(update, { ...commit, error: failure });
    }
    steps.push(rollback);
    const f = fixture(steps);
    const result = await f.service.confirmNoteProposal(input);
    denied(result, stage === "missing-receipt" ? "CONFLICT" : "UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(result), /sentinel/);
    f.done();
  });
test("exact replay after later note edits returns original note identity without writes or timestamp changes", async () => {
  const f = fixture([
    begin,
    discovery,
    conversation,
    { ...proposal, rows: [receipt] },
    project,
    noteRead,
    commit,
  ]);
  assert.equal(success(await f.service.confirmNoteProposal(input)).replayed, true);
  assert.ok(!f.calls.some((s) => /^(insert|update)/.test(s)));
  f.done();
});
test("confirmed proposal rejects each changed canonical field without comparing current note content", async () => {
  for (const changed of [
    { title: "Different" },
    { content: input.content.trim() },
    { noteDate: "2024-02-29" },
    { projectId: otherProjectId },
  ]) {
    const f = fixture([
      begin,
      discovery,
      conversation,
      { ...proposal, rows: [receipt] },
      project,
      rollback,
    ]);
    denied(await f.service.confirmNoteProposal({ ...input, ...changed }), "CONFLICT");
    f.done();
  }
});
test("replay still verifies original note belongs to the approved owned project", async () => {
  const f = fixture([
    begin,
    discovery,
    conversation,
    { ...proposal, rows: [receipt] },
    project,
    { ...noteRead, rows: [] },
    rollback,
  ]);
  denied(await f.service.confirmNoteProposal(input), "NOT_FOUND");
  f.done();
});

// Deterministic offline lock/commit simulator under real Drizzle SQL. The
// proposal mutex (not conversation SHARE) serializes writers. Not PostgreSQL MVCC proof.
function concurrentFixture(loseAcknowledgement = false) {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  let committed: unknown[] = [proposalId, "proposed", null, null, null, null, null];
  let tail = Promise.resolve();
  let inserts = 0;
  let locks = 0;
  const errors: unknown[] = [];
  db.$client.query = (async () => {
    throw new Error("No pool query allowed");
  }) as typeof db.$client.query;
  db.$client.connect = (async () => {
    let staged = committed;
    let inserted = false;
    let release: (() => void) | undefined;
    return {
      on() {},
      off() {},
      release() {},
      query: async ({ text }: { text: string }, params: unknown[] = []) => {
        try {
          let rows: unknown[][] = [];
          if (text.startsWith("begin")) assert.match(text, /read committed/);
          else if (
            text.includes('from "note_proposals"') &&
            text.endsWith('for update of "note_proposals"')
          ) {
            const previous = tail;
            tail = new Promise<void>((resolve) => {
              release = resolve;
            });
            await previous;
            locks++;
            staged = [...committed];
            rows = [staged];
          } else if (text.includes('from "note_proposals"')) rows = [[conversationId]];
          else if (text.includes('from "chat_conversations"')) {
            assert.match(text, /for share/);
            rows = [[conversationId, null]];
          } else if (text.startsWith('select "id" from "notes"'))
            rows = committed[2] ? [[committed[2]]] : [];
          else if (text.includes('from "projects"')) rows = [[projectId]];
          else if (text.startsWith('insert into "notes"')) {
            inserted = true;
            rows = [[noteId, projectId, params[1], params[2], params[3], now, now]];
          } else if (text.startsWith('update "note_proposals"')) {
            staged = [
              proposalId,
              "confirmed",
              params[1],
              params[2],
              params[3],
              params[4],
              params[5],
            ];
            rows = [[proposalId]];
          } else if (text.startsWith("commit")) {
            committed = staged;
            if (inserted) inserts++;
            release?.();
            release = undefined;
            if (loseAcknowledgement && inserted) throw new Error("synthetic lost acknowledgement");
          } else if (text.startsWith("rollback")) {
            release?.();
            release = undefined;
          } else throw new Error(`Unexpected simulator SQL: ${text}`);
          return { rows, rowCount: rows.length };
        } catch (error) {
          if (!(error instanceof Error && error.message === "synthetic lost acknowledgement"))
            errors.push(error);
          throw error;
        }
      },
    };
  }) as unknown as typeof db.$client.connect;
  return {
    service: createWorkspaceService({ db, getSession: async () => ({ user: { id: "user-a" } }) }),
    inserts: () => inserts,
    locks: () => locks,
    errors,
  };
}
for (const changed of [false, true])
  test(`concurrent confirmations serialize on proposal row: ${changed ? "changed payload conflicts" : "exact payload replays"}`, async () => {
    const f = concurrentFixture();
    const results = await Promise.all([
      f.service.confirmNoteProposal(input),
      f.service.confirmNoteProposal(changed ? { ...input, title: "Another" } : input),
    ]);
    assert.equal(f.inserts(), 1);
    assert.equal(f.locks(), 2);
    assert.deepEqual(f.errors, []);
    assert.equal(success(results[0]!).replayed, false);
    if (changed) denied(results[1]!, "CONFLICT");
    else assert.equal(success(results[1]!).replayed, true);
  });
test("lost commit acknowledgement leaves a committed receipt; same identity replay cannot create another note", async () => {
  const f = concurrentFixture(true);
  denied(await f.service.confirmNoteProposal(input), "UNAVAILABLE");
  const replayed = success(await f.service.confirmNoteProposal(input));
  assert.equal(replayed.noteId, noteId);
  assert.equal(replayed.replayed, true);
  assert.equal(f.inserts(), 1);
  assert.deepEqual(f.errors, []);
});
