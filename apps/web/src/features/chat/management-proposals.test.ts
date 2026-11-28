import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createDb } from "@solyn/db";
import { createChatService, PENDING_TIMEOUT_MS } from "./service";
import { createWorkspaceService } from "../workspace/service";
import * as c from "./management-contracts";
import { parseManagementProposal } from "./management-proposals";

const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const proposalId = id(1),
  conversationId = id(2),
  turnId = id(3),
  projectId = id(4),
  noteId = id(5),
  taskId = id(6),
  assistantId = id(7),
  userId = id(8),
  otherProjectId = id(9);
const now = new Date("2026-01-01T00:00:00Z");
const projectDraft = {
  schemaVersion: 1 as const,
  kind: "create_project" as const,
  name: "Project",
  description: null,
};
const fields = {
  title: "Task",
  description: null,
  status: "todo" as const,
  priority: null,
  assignee: null,
  dueDate: null,
  sourceNoteId: null,
};
const item = (itemId = 1) => ({ itemId, fields, evidence: { type: "user_message" as const } });
const taskDraft = {
  schemaVersion: 1 as const,
  kind: "create_tasks" as const,
  scopedProjectId: null,
  items: [item(), item(2)],
};
const projectApproval = {
  proposalId,
  kind: "create_project" as const,
  name: "Project",
  description: null,
};
const taskApproval = {
  proposalId,
  kind: "create_tasks" as const,
  projectId,
  items: [
    { itemId: 2, fields },
    { itemId: 1, fields },
  ],
};
const projectReceipt = {
  schemaVersion: 1,
  kind: "create_project",
  approved: { name: "Project", description: null },
  result: { projectId },
};
const taskReceipt = {
  schemaVersion: 1,
  kind: "create_tasks",
  approved: {
    projectId,
    items: [
      { itemId: 1, fields },
      { itemId: 2, fields },
    ],
  },
  results: [
    { itemId: 1, taskId, projectId, version: 1 },
    { itemId: 2, taskId: id(8), projectId, version: 1 },
  ],
};
const ref = { noteId, projectId, retrievedUpdatedAt: now.toISOString() };
const retrievedItem = {
  itemId: 1,
  fields: { ...fields, sourceNoteId: noteId },
  evidence: { type: "retrieved_note" as const, ...ref, excerptOnly: true as const },
};
const retrievedDraft = { ...taskDraft, items: [retrievedItem] };
const completion = (draft: unknown = projectDraft, sourceRefs: unknown = null) => ({
  conversationId,
  turnId,
  content: "Ready for review",
  draft,
  sourceRefs,
});
const conversationRow = (scope: string | null = null) => [
  conversationId,
  scope,
  "Conversation",
  now,
  now,
];
const messageRow = (status = "pending", refs: unknown = null) => [
  assistantId,
  conversationId,
  turnId,
  "assistant",
  status === "pending" ? "" : "Ready for review",
  status,
  "test/model",
  now,
  now,
  refs,
];
const lockedRow = (
  draft: unknown = projectDraft,
  receipt: unknown = null,
  refs: unknown = null,
  mixed = false,
) => [
  proposalId,
  (draft as { kind: string }).kind,
  receipt ? "confirmed" : "proposed",
  draft,
  receipt,
  receipt ? now : null,
  refs,
  mixed,
];
const viewRow = (
  draft: unknown = projectDraft,
  receipt: unknown = null,
  refs: unknown = null,
  scope: string | null = null,
) => [
  proposalId,
  assistantId,
  (draft as { kind: string }).kind,
  receipt ? "confirmed" : "proposed",
  draft,
  receipt,
  receipt ? now : null,
  conversationId,
  turnId,
  scope,
  scope ? "Project" : null,
  refs,
  false,
];
type Step = {
  sql: RegExp;
  rows?: unknown[];
  error?: boolean;
  inspect?: (sql: string, params: unknown[]) => void;
};
function fixture(steps: Step[] = [], user: string | null = "user-a") {
  const db = createDb({ DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused" });
  const remaining = [...steps],
    errors: unknown[] = [],
    calls: string[] = [];
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
    if (step!.error) throw new Error("Private SQL error sentinel");
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
  const dependencies = {
    db,
    getSession: async () => {
      sessions++;
      return user ? { user: { id: user } } : null;
    },
  };
  return {
    chat: createChatService(dependencies),
    workspace: createWorkspaceService(dependencies),
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
function data<T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected success");
  return result.data;
}
function denied(result: { ok: boolean; error?: { code: string } }, code: string) {
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, code);
  assert.doesNotMatch(JSON.stringify(result), /sentinel|Private SQL/);
}
const begin = { sql: /^begin isolation level read committed$/ },
  commit = { sql: /^commit$/ },
  rollback = { sql: /^rollback$/ };
const owned = (sql: string, params: unknown[]) => {
  assert.match(sql, /"owner_id" = \$/);
  assert.ok(params.includes("user-a"));
};
const discover: Step = {
  sql: /^select .*from "management_proposals".*inner join "chat_messages"/,
  rows: [[conversationId]],
  inspect: owned,
};
const conversation: Step = {
  sql: /from "chat_conversations".*for share of "chat_conversations"$/,
  rows: [[conversationId, null]],
  inspect: owned,
};
const locked = (
  draft: unknown = projectDraft,
  receipt: unknown = null,
  refs: unknown = null,
): Step => ({
  sql: /from "management_proposals".*for update of "management_proposals"$/,
  rows: [lockedRow(draft, receipt, refs)],
  inspect: owned,
});
const project: Step = { sql: /from "projects".*for share$/, rows: [[projectId]], inspect: owned };
const insertProject: Step = {
  sql: /^insert into "projects"/,
  rows: [[projectId, "Project", null, now, now]],
  inspect: (_s, p) => assert.deepEqual(p, ["user-a", "Project", null]),
};
const insertTask = (task = taskId): Step => ({
  sql: /^insert into "tasks"/,
  rows: [[task, projectId, "Task", null, "todo", null, null, null, null, 1, now, now, null]],
});
const receiptUpdate: Step = {
  sql: /^update "management_proposals"/,
  rows: [[proposalId]],
  inspect: (s) => {
    assert.match(s, /clock_timestamp\(\)/);
    assert.doesNotMatch(s, /"(?:draft|kind|source_message_id|created_at)" =/);
  },
};
const view = (
  draft: unknown = projectDraft,
  receipt: unknown = null,
  refs: unknown = null,
  scope: string | null = null,
): Step => ({
  sql: /^select "management_proposals".*from "management_proposals"/,
  rows: [viewRow(draft, receipt, refs, scope)],
  inspect: owned,
});
const resultProject: Step = { sql: /from "projects"/, rows: [[projectId]], inspect: owned };
const resultTasks = (
  rows: unknown[] = [
    [taskId, projectId, 1],
    [id(8), projectId, 1],
  ],
): Step => ({ sql: /from "tasks".*inner join "projects"/, rows, inspect: owned });
const start = (draft: unknown = projectDraft, receipt: unknown = null, refs: unknown = null) => [
  begin,
  discover,
  conversation,
  locked(draft, receipt, refs),
];
const finishProject = [
  insertProject,
  receiptUpdate,
  view(projectDraft, projectReceipt),
  resultProject,
  commit,
];
const chatLock: Step = {
  sql: /from "chat_conversations".*for update of "chat_conversations"$/,
  rows: [conversationRow()],
  inspect: owned,
};
const response = (status = "pending", refs: unknown = null): Step => ({
  sql: /from "chat_messages".*"turn_id"/,
  rows: [messageRow(status, refs)],
  inspect: (s, p) => {
    owned(s, p);
    assert.match(s, /not exists \(select .*from "note_proposals"/);
  },
});
const emptyExisting: Step = { sql: /^select "id" from "management_proposals"/ };
const user: Step = {
  sql: /from "chat_messages".*"role".*"status"/,
  rows: [["Explicit content"]],
  inspect: owned,
};
const clock: Step = { sql: /^select clock_timestamp\(\) as now$/, rows: [{ now }] };
const terminal: Step = {
  sql: /^update "chat_messages"/,
  rows: [messageRow("completed")],
  inspect: owned,
};
const insertProposal: Step = { sql: /^insert into "management_proposals"/, rows: [[proposalId]] };
const touch: Step = { sql: /^update "chat_conversations"/, rows: [[conversationId]] };
const completionStart = [begin, chatLock, response(), emptyExisting];
const completionEnd = [clock, terminal, insertProposal, touch, view(), commit];

test("strict contracts enforce canonical project/text/UUIDs, nested fields, nullable keys and sequential server item IDs", () => {
  const project = c.confirmManagementProposalInput.parse({
    ...projectApproval,
    proposalId: proposalId.toUpperCase(),
    name: " Project ",
  });
  assert.equal(project.kind, "create_project");
  if (project.kind === "create_project") assert.equal(project.name, "Project");
  const tasks = c.confirmManagementProposalInput.parse(taskApproval);
  assert.equal(tasks.kind, "create_tasks");
  if (tasks.kind === "create_tasks")
    assert.deepEqual(
      tasks.items.map((i) => i.itemId),
      [1, 2],
    );
  for (const draft of [
    { ...projectDraft, name: "\ud800" },
    { ...projectDraft, description: "\0" },
    { ...projectDraft, description: undefined },
    { ...projectDraft, ownerId: userId },
    { ...taskDraft, items: [] },
    { ...taskDraft, items: [item(2)] },
    { ...taskDraft, items: [item(), item()] },
    { ...taskDraft, items: Array.from({ length: 6 }, (_, i) => item(i + 1)) },
    { ...taskDraft, items: [{ ...item(), fields: { ...fields, dueDate: "2026-02-30" } }] },
    { ...taskDraft, items: [{ ...item(), fields: { ...fields, assignee: undefined } }] },
    { ...taskDraft, items: [{ ...item(), fields: { ...fields, sourceNoteId: noteId } }] },
    {
      ...retrievedDraft,
      items: [{ ...retrievedItem, evidence: { ...retrievedItem.evidence, ownerId: userId } }],
    },
  ])
    assert.equal(c.managementDraftSchema.safeParse(draft).success, false);
  assert.equal(
    c.confirmManagementProposalInput.safeParse({
      ...taskApproval,
      items: [
        { itemId: 1, fields },
        { itemId: 1, fields },
      ],
    }).success,
    false,
  );
  assert.equal(
    c.managementDraftSchema.safeParse({
      ...taskDraft,
      items: Array.from({ length: 5 }, (_, i) => ({
        ...item(i + 1),
        fields: { ...fields, description: "界".repeat(5000) },
      })),
    }).success,
    false,
  );
});
test("receipt identity mapping and reserved update contracts are strict and bounded", () => {
  assert.equal(c.managementReceiptSchema.safeParse(taskReceipt).success, true);
  for (const receipt of [
    { ...taskReceipt, results: taskReceipt.results.slice(1) },
    { ...taskReceipt, results: [taskReceipt.results[1], taskReceipt.results[0]] },
    { ...taskReceipt, results: taskReceipt.results.map((r) => ({ ...r, taskId })) },
    {
      ...taskReceipt,
      results: taskReceipt.results.map((r) => ({ ...r, projectId: otherProjectId })),
    },
  ])
    assert.equal(c.managementReceiptSchema.safeParse(receipt).success, false);
  const update = {
    schemaVersion: 1,
    kind: "update_task",
    taskId,
    projectId,
    expectedVersion: 1,
    changes: { description: null },
  };
  assert.equal(c.managementDraftSchema.safeParse(update).success, true);
  for (const changes of [{}, { projectId }, { completedAt: now }, { title: null }])
    assert.equal(c.managementDraftSchema.safeParse({ ...update, changes }).success, false);
  const receipt = {
    schemaVersion: 1,
    kind: "update_task",
    approved: { taskId, expectedVersion: 1, changes: { description: null } },
    result: { taskId, projectId, version: 1, changed: false },
  };
  assert.equal(c.managementReceiptSchema.safeParse(receipt).success, true);
  assert.equal(
    c.managementReceiptSchema.safeParse({ ...receipt, result: { ...receipt.result, version: 2 } })
      .success,
    false,
  );
  assert.equal(
    c.managementEqual(
      { changes: { title: "X", description: null } },
      { changes: { description: null, title: "X" } },
    ),
    true,
  );
});
test("persisted state parsing fails closed on kind/status/receipt/scope inconsistencies", () => {
  for (const row of [
    {
      kind: "create_tasks",
      status: "proposed",
      draft: projectDraft,
      receipt: null,
      confirmedAt: null,
    },
    {
      kind: "create_project",
      status: "confirmed",
      draft: projectDraft,
      receipt: null,
      confirmedAt: now,
    },
    {
      kind: "create_project",
      status: "proposed",
      draft: projectDraft,
      receipt: projectReceipt,
      confirmedAt: null,
    },
    {
      kind: "create_project",
      status: "proposed",
      draft: projectDraft,
      receipt: null,
      confirmedAt: now,
    },
  ])
    assert.throws(() => parseManagementProposal(row, null));
});
test("fresh sessions precede strict input validation/SQL, and expire after a successful confirmation", async () => {
  const f = fixture([...start(), ...finishProject]);
  data(await f.workspace.confirmManagementProposal(projectApproval));
  f.expire();
  denied(await f.workspace.confirmManagementProposal(projectApproval), "UNAUTHENTICATED");
  denied(await f.chat.getManagementProposal({ proposalId }), "UNAUTHENTICATED");
  denied(await f.chat.completeManagementProposal(completion()), "UNAUTHENTICATED");
  assert.equal(f.sessions(), 4);
  f.done();
  const bad = fixture([]);
  denied(
    await bad.workspace.confirmManagementProposal({ ...projectApproval, ownerId: userId }),
    "INVALID_INPUT",
  );
  denied(
    await bad.chat.completeManagementProposal({ ...completion(), status: "completed" }),
    "INVALID_INPUT",
  );
  bad.done();
});
test("project confirmation uses session owner and commits project plus immutable receipt under ordered locks", async () => {
  const f = fixture([...start(), ...finishProject]);
  const result = data(
    await f.workspace.confirmManagementProposal({ ...projectApproval, name: " Project " }),
  );
  assert.equal(result.replayed, false);
  assert.deepEqual(result.proposal.receipt, {
    kind: "create_project",
    result: { state: "available", projectId, href: `/projects/${projectId}` },
  });
  assert.equal(f.calls.filter((s) => s.startsWith('insert into "projects"')).length, 1);
  assert.equal(f.calls.filter((s) => s.startsWith("begin")).length, 1);
  assert.ok(!f.calls.some((s) => s.startsWith('insert into "tasks"')));
  f.done();
});
test("confirmation denies missing/foreign discovery, lock and recheck without leaking source identity", async () => {
  for (const steps of [
    [begin, { ...discover, rows: [] }, rollback],
    [begin, discover, { ...conversation, rows: [] }, rollback],
    [begin, discover, conversation, { ...locked(), rows: [] }, rollback],
  ]) {
    const f = fixture(steps);
    denied(await f.workspace.confirmManagementProposal(projectApproval), "NOT_FOUND");
    f.done();
  }
});
test("batch creates selected items atomically, canonicalizes selection order and does not insert unselected items", async () => {
  const approval = { ...taskApproval, items: [{ itemId: 2, fields }] };
  const receipt = {
    ...taskReceipt,
    approved: { projectId, items: approval.items },
    results: [{ itemId: 2, taskId, projectId, version: 1 }],
  };
  const f = fixture([
    ...start(taskDraft),
    project,
    project,
    insertTask(),
    receiptUpdate,
    view(taskDraft, receipt),
    resultTasks([[taskId, projectId, 1]]),
    commit,
  ]);
  const result = data(await f.workspace.confirmManagementProposal(approval));
  assert.equal(result.proposal.receipt?.kind, "create_tasks");
  assert.equal(f.calls.filter((s) => s.startsWith('insert into "tasks"')).length, 1);
  f.done();
});
test("batch accepts project chat only in its fixed owned project", async () => {
  const scopedDraft = { ...taskDraft, scopedProjectId: projectId };
  const steps = [
    begin,
    discover,
    { ...conversation, rows: [[conversationId, projectId]] },
    locked(scopedDraft),
    project,
    rollback,
  ];
  const f = fixture(steps);
  denied(
    await f.workspace.confirmManagementProposal({ ...taskApproval, projectId: otherProjectId }),
    "CONFLICT",
  );
  f.done();
  const foreign = fixture([...start(taskDraft), { ...project, rows: [] }, rollback]);
  denied(await foreign.workspace.confirmManagementProposal(taskApproval), "NOT_FOUND");
  foreign.done();
});
test("unseen items, substituted sources and changing selected subsets after confirmation conflict", async () => {
  for (const items of [
    [{ itemId: 3, fields }],
    [{ itemId: 1, fields: { ...fields, sourceNoteId: noteId } }],
  ]) {
    const f = fixture([...start(taskDraft), project, rollback]);
    denied(await f.workspace.confirmManagementProposal({ ...taskApproval, items }), "CONFLICT");
    f.done();
  }
  const f = fixture([...start(taskDraft, taskReceipt), rollback]);
  denied(
    await f.workspace.confirmManagementProposal({
      ...taskApproval,
      items: [{ itemId: 1, fields }],
    }),
    "CONFLICT",
  );
  f.done();
});
test("retrieval evidence is reauthorized and timestamp-checked even after source link clearing", async () => {
  for (const state of ["missing", "changed", "wrong_project"]) {
    const note: Step = {
      sql: /from "notes".*for share of "notes"$/,
      rows:
        state === "missing"
          ? []
          : [[noteId, state === "changed" ? new Date(now.getTime() + 1) : now]],
      inspect: owned,
    };
    const draft =
      state === "wrong_project"
        ? {
            ...retrievedDraft,
            items: [
              {
                ...retrievedItem,
                evidence: { ...retrievedItem.evidence, projectId: otherProjectId },
              },
            ],
          }
        : retrievedDraft;
    const refs = state === "wrong_project" ? [{ ...ref, projectId: otherProjectId }] : [ref];
    const f = fixture([...start(draft, null, refs), project, note, rollback]);
    denied(
      await f.workspace.confirmManagementProposal({
        ...taskApproval,
        items: [{ itemId: 1, fields }],
      }),
      state === "missing" ? "NOT_FOUND" : "CONFLICT",
    );
    f.done();
  }
});
test("selected evidence notes lock in deterministic UUID order before any insert", async () => {
  const draft = {
    ...taskDraft,
    items: [
      {
        ...retrievedItem,
        fields: { ...fields, sourceNoteId: id(8) },
        evidence: { ...retrievedItem.evidence, noteId: id(8) },
      },
      { ...retrievedItem, itemId: 2 },
    ],
  };
  const f = fixture([
    ...start(draft, null, [{ ...ref, noteId: id(8) }, ref]),
    project,
    {
      sql: /from "notes".*for share/,
      rows: [[noteId, now]],
      inspect: (_s, p) => assert.ok(p.includes(noteId)),
    },
    { sql: /from "notes".*for share/, rows: [], inspect: (_s, p) => assert.ok(p.includes(id(8))) },
    rollback,
  ]);
  denied(await f.workspace.confirmManagementProposal(taskApproval), "NOT_FOUND");
  assert.ok(!f.calls.some((s) => s.startsWith('insert into "tasks"')));
  f.done();
});
test("failed second insert, missing RETURNING, receipt failure and commit error never acknowledge a partial batch", async () => {
  for (const point of ["second_insert", "missing_returning", "receipt", "commit"]) {
    const operations: Step[] = [
      project,
      project,
      insertTask(),
      project,
      insertTask(id(8)),
      receiptUpdate,
      view(taskDraft, taskReceipt),
      resultTasks(),
      commit,
    ];
    const index =
      point === "second_insert" || point === "missing_returning" ? 4 : point === "receipt" ? 5 : 8;
    const failureStep = {
      ...operations[index]!,
      ...(point === "missing_returning" ? { rows: [] } : { error: true }),
    };
    const f = fixture([...start(taskDraft), ...operations.slice(0, index), failureStep, rollback]);
    denied(await f.workspace.confirmManagementProposal(taskApproval), "UNAVAILABLE");
    assert.equal(f.calls.at(-1), "rollback");
    assert.equal(f.calls.filter((s) => s.startsWith("begin")).length, 1);
    f.done();
  }
});
test("exact canonical replay returns original identities with current versions, never rewrites historical approval", async () => {
  const f = fixture([
    ...start(taskDraft, taskReceipt),
    view(taskDraft, taskReceipt),
    resultTasks([
      [taskId, projectId, 7],
      [id(8), projectId, 2],
    ]),
    commit,
  ]);
  const result = data(await f.workspace.confirmManagementProposal(taskApproval));
  assert.equal(result.replayed, true);
  if (result.proposal.receipt?.kind !== "create_tasks") throw new Error("Expected task receipt");
  assert.equal(result.proposal.receipt.results[0]!.state, "available");
  assert.doesNotMatch(f.calls.join("\n"), /^(insert|update|delete)/m);
  f.done();
});
test("confirmed replay ignores subsequent source edits and projects deleted/moved results unavailable without IDs or links", async () => {
  const receipt = {
    ...taskReceipt,
    approved: { projectId, items: [{ itemId: 1, fields: retrievedItem.fields }] },
    results: [{ itemId: 1, taskId, projectId, version: 1 }],
  };
  const f = fixture([
    ...start(retrievedDraft, receipt, [ref]),
    view(retrievedDraft, receipt, [ref]),
    { sql: /from "notes".*inner join "projects"/, rows: [] },
    resultTasks([[taskId, otherProjectId, 9]]),
    commit,
  ]);
  const result = data(
    await f.workspace.confirmManagementProposal({
      ...taskApproval,
      items: [{ itemId: 1, fields: retrievedItem.fields }],
    }),
  );
  assert.deepEqual(result.proposal.receipt, {
    kind: "create_tasks",
    results: [{ itemId: 1, state: "unavailable" }],
  });
  assert.ok(!JSON.stringify(result).includes(taskId));
  assert.ok(!JSON.stringify(result).includes(noteId));
  assert.ok(!f.calls.some((s) => s.includes('for share of "notes"')));
  f.done();
});
test("conflicting project approval is rejected and unavailable project results remain confirmed", async () => {
  const conflict = fixture([...start(projectDraft, projectReceipt), rollback]);
  denied(
    await conflict.workspace.confirmManagementProposal({ ...projectApproval, name: "Different" }),
    "CONFLICT",
  );
  conflict.done();
  const f = fixture([
    ...start(projectDraft, projectReceipt),
    view(projectDraft, projectReceipt),
    { ...resultProject, rows: [] },
    commit,
  ]);
  const result = data(await f.workspace.confirmManagementProposal(projectApproval));
  assert.deepEqual(result.proposal.receipt, {
    kind: "create_project",
    result: { state: "unavailable" },
  });
  assert.ok(!JSON.stringify(result).includes(projectId));
  f.done();
});
test("mixed stored proposals and unsupported update changes fail closed", async () => {
  const f = fixture([
    begin,
    discover,
    conversation,
    { ...locked(), rows: [lockedRow(projectDraft, null, null, true)] },
    rollback,
  ]);
  denied(await f.workspace.confirmManagementProposal(projectApproval), "CONFLICT");
  f.done();
  const update = { kind: "update_task", taskId, expectedVersion: 1, changes: { status: "done" } };
  const invalid = fixture();
  denied(
    await invalid.workspace.confirmManagementProposal({
      proposalId,
      ...update,
      changes: { sourceNoteId: noteId },
    }),
    "INVALID_INPUT",
  );
  denied(
    await invalid.chat.completeManagementProposal(
      completion({ schemaVersion: 1, projectId, ...update, changes: { projectId } }),
    ),
    "INVALID_INPUT",
  );
  invalid.done();
});
test("internal management completion atomically completes assistant and persists draft, never creates knowledge", async () => {
  const f = fixture([...completionStart, user, ...completionEnd]);
  const result = data(await f.chat.completeManagementProposal(completion()));
  assert.equal(result.managementProposal.id, proposalId);
  assert.doesNotMatch(f.calls.join("\n"), /insert into "(?:tasks|projects|notes)"/);
  f.done();
});
test("completion rejects stopped/failed turns, mixed note source and duplicate pending proposals", async () => {
  for (const status of ["stopped", "failed"]) {
    const f = fixture([
      begin,
      chatLock,
      response(status),
      { sql: /^select "draft" from "management_proposals"/ },
      rollback,
    ]);
    denied(await f.chat.completeManagementProposal(completion()), "CONFLICT");
    f.done();
  }
  const mixed = fixture([begin, chatLock, { ...response(), rows: [] }, rollback]);
  denied(await mixed.chat.completeManagementProposal(completion()), "NOT_FOUND");
  mixed.done();
  const duplicate = fixture([
    begin,
    chatLock,
    response(),
    { ...emptyExisting, rows: [[proposalId]] },
    rollback,
  ]);
  denied(await duplicate.chat.completeManagementProposal(completion()), "CONFLICT");
  duplicate.done();
});
test("completion enforces Main-only project proposals and exact fixed task scope/retrieval bindings", async () => {
  for (const draft of [projectDraft, taskDraft]) {
    const f = fixture([
      begin,
      { ...chatLock, rows: [conversationRow(projectId)] },
      response(),
      emptyExisting,
      rollback,
    ]);
    denied(await f.chat.completeManagementProposal(completion(draft)), "INVALID_INPUT");
    f.done();
  }
  const refs = fixture([...completionStart, rollback]);
  denied(await refs.chat.completeManagementProposal(completion(retrievedDraft)), "INVALID_INPUT");
  refs.done();
});
test("completion reauthorizes retrieved notes and rejects changed, missing or wrong-parent evidence before terminal writes", async () => {
  for (const changed of [true, false]) {
    const f = fixture([
      ...completionStart,
      user,
      {
        sql: /from "notes".*for share of "notes"$/,
        rows: changed ? [[noteId, new Date(now.getTime() + 1)]] : [],
        inspect: (s, p) => {
          owned(s, p);
          assert.ok(p.includes(projectId));
        },
      },
      rollback,
    ]);
    denied(
      await f.chat.completeManagementProposal(completion(retrievedDraft, [ref])),
      changed ? "CONFLICT" : "NOT_FOUND",
    );
    assert.ok(!f.calls.some((s) => s.startsWith("update")));
    f.done();
  }
});
test("completion rejects absent user and expired pending turns; insertion/commit failures roll back", async () => {
  const absent = fixture([...completionStart, { ...user, rows: [] }, rollback]);
  denied(await absent.chat.completeManagementProposal(completion()), "NOT_FOUND");
  absent.done();
  const expired = fixture([
    ...completionStart,
    user,
    { ...clock, rows: [{ now: new Date(now.getTime() + PENDING_TIMEOUT_MS) }] },
    rollback,
  ]);
  denied(await expired.chat.completeManagementProposal(completion()), "CONFLICT");
  expired.done();
  for (const index of [2, 5]) {
    const operations = [clock, terminal, insertProposal, touch, view(), commit];
    const f = fixture([
      ...completionStart,
      user,
      ...operations.slice(0, index),
      { ...operations[index]!, error: true },
      rollback,
    ]);
    denied(await f.chat.completeManagementProposal(completion()), "UNAVAILABLE");
    f.done();
  }
});
test("exact terminal callback replay reads original proposal/receipt and changes no timestamps", async () => {
  const f = fixture([
    begin,
    chatLock,
    response("completed"),
    { sql: /^select "draft" from "management_proposals"/, rows: [[projectDraft]] },
    view(projectDraft, projectReceipt),
    resultProject,
    commit,
  ]);
  const result = data(await f.chat.completeManagementProposal(completion()));
  assert.equal(result.managementProposal.status, "confirmed");
  assert.doesNotMatch(f.calls.join("\n"), /^(insert|update|delete)/m);
  f.done();
  const changed = fixture([
    begin,
    chatLock,
    response("completed"),
    { sql: /^select "draft" from "management_proposals"/, rows: [[projectDraft]] },
    rollback,
  ]);
  denied(
    await changed.chat.completeManagementProposal(completion({ ...projectDraft, name: "Other" })),
    "CONFLICT",
  );
  changed.done();
});
test("authenticated recovery validates JSON and hides unavailable result identity", async () => {
  const f = fixture([
    { sql: /^begin isolation level repeatable read read only$/ },
    view(taskDraft, taskReceipt),
    resultTasks([]),
    commit,
  ]);
  const result = data(await f.chat.getManagementProposal({ proposalId }));
  assert.equal(result.status, "confirmed");
  assert.ok(!JSON.stringify(result).includes(taskId));
  f.done();
  const missing = fixture([{ sql: /^begin/ }, { ...view(), rows: [] }, rollback]);
  denied(await missing.chat.getManagementProposal({ proposalId }), "NOT_FOUND");
  missing.done();
  const invalid = fixture([
    { sql: /^begin/ },
    { ...view(), rows: [viewRow({ ...projectDraft, extra: true })] },
    rollback,
  ]);
  denied(await invalid.chat.getManagementProposal({ proposalId }), "UNAVAILABLE");
  invalid.done();
});
test("history uses bounded management/source/result batch reads for the current message page", async () => {
  const f = fixture([
    { sql: /^begin isolation level repeatable read read only$/ },
    { sql: /from "chat_conversations"/, rows: [conversationRow()] },
    { sql: /from "chat_messages".*order by.*limit/, rows: [messageRow("completed")] },
    { sql: /from "chat_messages".*"status".*limit/ },
    clock,
    { sql: /from "note_proposals"/ },
    view(projectDraft, projectReceipt),
    resultProject,
    commit,
  ]);
  const result = data(await f.chat.getConversation({ conversationId, limit: 1 }));
  assert.equal(result.messages[0]!.managementProposal?.id, proposalId);
  assert.equal(result.messages[0]!.proposal, null);
  f.done();
});
test("begin replay returns management proposal without another generation or mutation", async () => {
  const f = fixture([
    begin,
    chatLock,
    {
      sql: /from "chat_messages".*"turn_id"/,
      rows: [
        [
          userId,
          conversationId,
          turnId,
          "user",
          "Explicit content",
          "completed",
          null,
          now,
          now,
          null,
        ],
        messageRow("completed"),
      ],
    },
    clock,
    { sql: /from "note_proposals"/ },
    view(),
    commit,
  ]);
  const result = data(
    await f.chat.beginTurn({
      conversationId,
      turnId,
      content: "Explicit content",
      modelId: "test/model",
    }),
  );
  assert.equal(result.managementProposal?.id, proposalId);
  assert.equal(result.replayed, true);
  assert.doesNotMatch(f.calls.join("\n"), /^(insert|update|delete)/m);
  f.done();
});
test("conversation deletion removes both proposal types before messages, retains knowledge and denies confirmation after deletion", async () => {
  const f = fixture([
    begin,
    chatLock,
    { sql: /from "chat_messages".*"status".*limit/ },
    { sql: /^delete from "management_proposals"/, inspect: owned },
    { sql: /^delete from "note_proposals"/, inspect: owned },
    { sql: /^delete from "chat_messages"/ },
    { sql: /^delete from "chat_conversations"/, rows: [[conversationId]] },
    commit,
    begin,
    { ...discover, rows: [] },
    rollback,
  ]);
  data(await f.chat.deleteConversation({ conversationId }));
  denied(await f.workspace.confirmManagementProposal(projectApproval), "NOT_FOUND");
  assert.doesNotMatch(
    f.calls.join("\n"),
    /^(delete from|update) "(?:projects|tasks|notes|note_revisions)"/m,
  );
  f.done();
});
test("confirmation-before-deletion commits knowledge first; pending and project threads still deny deletion", async () => {
  const f = fixture([
    ...start(),
    ...finishProject,
    begin,
    chatLock,
    { sql: /from "chat_messages".*"status".*limit/ },
    { sql: /^delete from "management_proposals"/ },
    { sql: /^delete from "note_proposals"/ },
    { sql: /^delete from "chat_messages"/ },
    { sql: /^delete from "chat_conversations"/, rows: [[conversationId]] },
    commit,
  ]);
  data(await f.workspace.confirmManagementProposal(projectApproval));
  data(await f.chat.deleteConversation({ conversationId }));
  assert.ok(
    f.calls.indexOf("commit") <
      f.calls.findIndex((s) => s.startsWith('delete from "management_proposals"')),
  );
  f.done();
  for (const scoped of [true, false]) {
    const deniedDelete = fixture([
      begin,
      { ...chatLock, rows: [conversationRow(scoped ? projectId : null)] },
      ...(scoped ? [] : [{ sql: /from "chat_messages".*"status".*limit/, rows: [[assistantId]] }]),
      rollback,
    ]);
    denied(
      await deniedDelete.chat.deleteConversation({ conversationId }),
      scoped ? "NOT_FOUND" : "CONFLICT",
    );
    deniedDelete.done();
  }
});
test("successful full batches create all selected tasks in one transaction in both Main and fixed project chat", async () => {
  for (const scope of [null, projectId]) {
    const draft = { ...taskDraft, scopedProjectId: scope };
    const f = fixture([
      begin,
      discover,
      { ...conversation, rows: [[conversationId, scope]] },
      locked(draft),
      project,
      project,
      insertTask(),
      project,
      insertTask(id(8)),
      receiptUpdate,
      view(draft, taskReceipt, null, scope),
      resultTasks(),
      commit,
    ]);
    const result = data(await f.workspace.confirmManagementProposal(taskApproval));
    assert.equal(result.proposal.receipt?.kind, "create_tasks");
    if (result.proposal.receipt?.kind === "create_tasks")
      assert.equal(result.proposal.receipt.results.length, 2);
    f.done();
  }
});
test("successful retrieved-task completion persists source refs and exposes only authorized evidence", async () => {
  const f = fixture([
    ...completionStart,
    user,
    { sql: /from "notes".*for share of "notes"$/, rows: [[noteId, now]], inspect: owned },
    clock,
    {
      ...terminal,
      rows: [messageRow("completed", [ref])],
      inspect: (s, p) => {
        owned(s, p);
        assert.ok(p.includes(JSON.stringify([ref])));
      },
    },
    insertProposal,
    touch,
    view(retrievedDraft, null, [ref]),
    {
      sql: /from "notes".*inner join "projects"/,
      rows: [[noteId, projectId, now]],
      inspect: owned,
    },
    {
      sql: /from "notes".*inner join "projects"/,
      rows: [[noteId, projectId, "Source", now, "Project"]],
      inspect: owned,
    },
    commit,
  ]);
  const result = data(await f.chat.completeManagementProposal(completion(retrievedDraft, [ref])));
  assert.equal(result.sources[0]?.state, "available");
  assert.equal(result.managementProposal.draft.kind, "create_tasks");
  f.done();
});
test("successful retrieved batch confirmation validates evidence even when clearing the saved source link", async () => {
  const approved = { ...taskApproval, items: [{ itemId: 1, fields }] };
  const receipt = {
    ...taskReceipt,
    approved: { projectId, items: approved.items },
    results: [{ itemId: 1, taskId, projectId, version: 1 }],
  };
  const f = fixture([
    ...start(retrievedDraft, null, [ref]),
    project,
    { sql: /from "notes".*for share of "notes"$/, rows: [[noteId, now]], inspect: owned },
    project,
    insertTask(),
    receiptUpdate,
    view(retrievedDraft, receipt, [ref]),
    { sql: /from "notes".*inner join "projects"/, rows: [[noteId, projectId, now]] },
    resultTasks([[taskId, projectId, 1]]),
    commit,
  ]);
  data(await f.workspace.confirmManagementProposal(approved));
  f.done();
});
test("legacy note completion and confirmation explicitly exclude management proposal sources", async () => {
  const chat = fixture([
    begin,
    chatLock,
    {
      sql: /from "chat_messages"/,
      rows: [],
      inspect: (s) => assert.match(s, /not exists \(select .*from "management_proposals"/),
    },
    rollback,
  ]);
  denied(
    await chat.chat.completeProposal({
      conversationId,
      turnId,
      content: "Draft",
      draft: { projectHint: null, title: "Note", content: "Text", noteDate: null },
    }),
    "NOT_FOUND",
  );
  chat.done();
  const workspace = fixture([
    begin,
    {
      sql: /from "note_proposals"/,
      rows: [],
      inspect: (s) => assert.match(s, /not exists \(select .*from "management_proposals"/),
    },
    rollback,
  ]);
  denied(
    await workspace.workspace.confirmNoteProposal({
      proposalId,
      projectId,
      title: "Note",
      content: "Text",
      noteDate: null,
    }),
    "NOT_FOUND",
  );
  workspace.done();
});
test("actions expose only authenticated confirmation/recovery and revalidate after success, not raw finalization", () => {
  const workspace = readFileSync(new URL("../workspace/actions.ts", import.meta.url), "utf8");
  const chat = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  assert.match(workspace, /export async function confirmManagementProposal/);
  assert.match(chat, /export async function getManagementProposal/);
  assert.doesNotMatch(
    workspace + chat,
    /export async function (?:completeManagementProposal|createManagementProposal|updateManagementReceipt)/,
  );
  assert.match(
    workspace,
    /const result = await workspace.confirmManagementProposal\(input\);\s*if \(result.ok\)/,
  );
});

const updateDraft = {
  schemaVersion: 1 as const,
  kind: "update_task" as const,
  taskId,
  projectId,
  expectedVersion: 1,
  changes: { status: "done" as const },
};
const updateApproval = {
  proposalId,
  kind: "update_task" as const,
  taskId,
  expectedVersion: 1,
  changes: { status: "done" as const },
};
const updateReceipt = (changed = true, changes: unknown = { status: "done" }) => ({
  schemaVersion: 1,
  kind: "update_task",
  approved: { taskId, expectedVersion: 1, changes },
  result: { taskId, projectId, version: changed ? 2 : 1, changed },
});
const fullTask = (overrides: object = {}) => ({
  id: taskId,
  projectId,
  title: "Task",
  description: null,
  status: "todo",
  priority: null,
  assignee: null,
  dueDate: null,
  sourceNoteId: noteId,
  version: 1,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
  ...overrides,
});
const lockUpdateTask = (overrides: object = {}): Step => ({
  sql: /from "tasks".*for update of "tasks"$/,
  rows: [Object.values(fullTask(overrides))],
  inspect: owned,
});
const updateTarget = (version = 2, status = "done"): Step => ({
  sql: /from "tasks" inner join "projects"/,
  rows: [[taskId, projectId, version, "Project", "Task", null, status, null, null, null]],
  inspect: owned,
});
const updateTaskWrite: Step = {
  sql: /^update "tasks"/,
  rows: [Object.values(fullTask({ status: "done", version: 2, completedAt: now }))],
  inspect: (s, p) => {
    owned(s, p);
    assert.ok(p.includes(noteId), "Source-note association must be preserved");
    assert.match(s, /"version" = \$/);
  },
};

test("update confirmation atomically shares the manual task core, preserves source association and records the actual result", async () => {
  const f = fixture([
    begin,
    discover,
    conversation,
    locked(updateDraft),
    project,
    lockUpdateTask(),
    updateTaskWrite,
    receiptUpdate,
    view(updateDraft, updateReceipt()),
    updateTarget(),
    commit,
  ]);
  const result = data(await f.workspace.confirmManagementProposal(updateApproval));
  assert.equal(result.replayed, false);
  assert.equal(result.proposal.status, "confirmed");
  assert.equal(result.proposal.receipt?.kind, "update_task");
  if (result.proposal.receipt?.kind !== "update_task") throw new Error("Wrong kind");
  assert.equal(result.proposal.receipt.changed, true);
  assert.equal(result.proposal.receipt.version, 2);
  assert.equal(result.proposal.receipt.result.state, "available");
  assert.doesNotMatch(f.calls.join("\n"), /insert into "tasks"|from "notes"|update "notes"/);
  f.done();
});

test("update no-op validates the version first, does not touch task timestamps and still atomically confirms", async () => {
  const approval = { ...updateApproval, changes: { title: "Task" } };
  const f = fixture([
    begin,
    discover,
    conversation,
    locked(updateDraft),
    project,
    lockUpdateTask(),
    receiptUpdate,
    view(updateDraft, updateReceipt(false, approval.changes)),
    updateTarget(1, "todo"),
    commit,
  ]);
  const result = data(await f.workspace.confirmManagementProposal(approval));
  assert.equal(result.proposal.receipt?.kind, "update_task");
  if (result.proposal.receipt?.kind !== "update_task") throw new Error("Wrong kind");
  assert.equal(result.proposal.receipt.changed, false);
  assert.equal(result.proposal.receipt.version, 1);
  assert.ok(!f.calls.some((s) => s.startsWith('update "tasks"')));
  f.done();
});

test("update reopen clears completion, preserves omitted fields and applies explicit nullable clears", async () => {
  const changes = {
    status: "todo",
    description: null,
    assignee: null,
    priority: null,
    dueDate: null,
  };
  const f = fixture([
    begin,
    discover,
    conversation,
    locked(updateDraft),
    project,
    lockUpdateTask({
      status: "done",
      completedAt: now,
      description: "Old",
      priority: "high",
      assignee: "A",
      dueDate: "2026-01-01",
    }),
    {
      sql: /^update "tasks"/,
      rows: [Object.values(fullTask({ version: 2 }))],
      inspect: (s, p) => {
        assert.match(s, /"completed_at" = \$/);
        assert.ok(p.includes(null));
        assert.ok(p.includes(noteId));
      },
    },
    receiptUpdate,
    view(updateDraft, updateReceipt(true, changes)),
    updateTarget(2, "todo"),
    commit,
  ]);
  data(await f.workspace.confirmManagementProposal({ ...updateApproval, changes }));
  f.done();
});

for (const [label, taskOverride, code] of [
  ["manual edit", { version: 2 }, "CONFLICT"],
  ["moved project", { projectId: otherProjectId }, "NOT_FOUND"],
  ["overflow", { version: 2147483647 }, "CONFLICT"],
] as const)
  test(`update confirmation denies ${label} without task/receipt writes`, async () => {
    const f = fixture([
      begin,
      discover,
      conversation,
      locked(updateDraft),
      project,
      lockUpdateTask(taskOverride),
      rollback,
    ]);
    denied(await f.workspace.confirmManagementProposal(updateApproval), code);
    assert.ok(!f.calls.some((s) => s.startsWith("update")));
    f.done();
  });

test("update proposals authenticate freshly and deny missing owned proposal discovery", async () => {
  const anonymous = fixture([], null);
  denied(
    await anonymous.chat.completeManagementProposal(completion(updateDraft)),
    "UNAUTHENTICATED",
  );
  denied(await anonymous.workspace.confirmManagementProposal(updateApproval), "UNAUTHENTICATED");
  anonymous.done();
  const absent = fixture([begin, { ...discover, rows: [] }, rollback]);
  denied(await absent.workspace.confirmManagementProposal(updateApproval), "NOT_FOUND");
  absent.done();
});

test("update proposal meaningful overflow is rejected without substituting a new version", async () => {
  const draft = { ...updateDraft, expectedVersion: 2147483647 };
  const f = fixture([
    begin,
    discover,
    conversation,
    locked(draft),
    project,
    lockUpdateTask({ version: 2147483647 }),
    rollback,
  ]);
  denied(
    await f.workspace.confirmManagementProposal({ ...updateApproval, expectedVersion: 2147483647 }),
    "CONFLICT",
  );
  f.done();
});

test("update confirmation cannot refresh identity/version or write a deleted or foreign target", async () => {
  for (const approval of [
    { ...updateApproval, taskId: id(8) },
    { ...updateApproval, expectedVersion: 2 },
  ]) {
    const f = fixture([begin, discover, conversation, locked(updateDraft), rollback]);
    denied(await f.workspace.confirmManagementProposal(approval), "CONFLICT");
    f.done();
  }
  const missingTarget = fixture([
    begin,
    discover,
    conversation,
    locked(updateDraft),
    project,
    { ...lockUpdateTask(), rows: [] },
    rollback,
  ]);
  denied(await missingTarget.workspace.confirmManagementProposal(updateApproval), "NOT_FOUND");
  missingTarget.done();
});

test("update statement, missing RETURNING, receipt or commit failures never report partial success", async () => {
  for (const failed of [0, 1, 2, 5]) {
    const tail = [
      updateTaskWrite,
      receiptUpdate,
      view(updateDraft, updateReceipt()),
      updateTarget(),
      commit,
    ];
    const index = failed === 5 ? 4 : failed;
    const f = fixture([
      begin,
      discover,
      conversation,
      locked(updateDraft),
      project,
      lockUpdateTask(),
      ...tail.slice(0, index),
      { ...tail[index]!, error: true },
      rollback,
    ]);
    denied(await f.workspace.confirmManagementProposal(updateApproval), "UNAVAILABLE");
    f.done();
  }
  const f = fixture([
    begin,
    discover,
    conversation,
    locked(updateDraft),
    project,
    lockUpdateTask(),
    { ...updateTaskWrite, rows: [] },
    rollback,
  ]);
  denied(await f.workspace.confirmManagementProposal(updateApproval), "CONFLICT");
  f.done();
});

for (const exists of [false, true])
  test(`exact update replay ignores later version/availability, never reexecutes (exists=${exists})`, async () => {
    const f = fixture([
      begin,
      discover,
      conversation,
      locked(updateDraft, updateReceipt()),
      view(updateDraft, updateReceipt()),
      exists ? updateTarget(9, "todo") : { ...updateTarget(), rows: [] },
      commit,
    ]);
    const result = data(await f.workspace.confirmManagementProposal(updateApproval));
    assert.equal(result.replayed, true);
    if (result.proposal.receipt?.kind !== "update_task") throw new Error("Wrong kind");
    assert.equal(result.proposal.receipt.version, 2);
    assert.equal(result.proposal.receipt.result.state, exists ? "available" : "unavailable");
    if (!exists) assert.doesNotMatch(JSON.stringify(result.proposal.receipt), new RegExp(taskId));
    assert.ok(!f.calls.some((s) => /^(insert|update|delete)/.test(s)));
    f.done();
  });

test("different confirmed update approval conflicts without touching a later manual edit", async () => {
  const f = fixture([
    begin,
    discover,
    conversation,
    locked(updateDraft, updateReceipt()),
    rollback,
  ]);
  denied(
    await f.workspace.confirmManagementProposal({ ...updateApproval, changes: { status: "todo" } }),
    "CONFLICT",
  );
  f.done();
});

test("update completion reauthorizes and share-locks the current target version before atomic proposal persistence", async () => {
  const f = fixture([
    ...completionStart,
    user,
    project,
    { sql: /from "tasks".*for share of "tasks"$/, rows: [[taskId, 1]], inspect: owned },
    clock,
    terminal,
    insertProposal,
    touch,
    view(updateDraft),
    updateTarget(1, "todo"),
    commit,
  ]);
  const result = data(await f.chat.completeManagementProposal(completion(updateDraft)));
  assert.equal(result.managementProposal.kind, "update_task");
  assert.ok(!f.calls.some((s) => /^(insert|update) (?:into )?"tasks"/.test(s)));
  f.done();
});

test("update completion rejects stale/missing/fixed-scope targets and fabricated note references", async () => {
  for (const [rows, code] of [
    [[[taskId, 2]], "CONFLICT"],
    [[], "NOT_FOUND"],
  ] as const) {
    const f = fixture([
      ...completionStart,
      user,
      project,
      { sql: /from "tasks".*for share of "tasks"$/, rows: [...rows], inspect: owned },
      rollback,
    ]);
    denied(await f.chat.completeManagementProposal(completion(updateDraft)), code);
    f.done();
  }
  const scope = fixture([
    begin,
    { ...chatLock, rows: [conversationRow(otherProjectId)] },
    response(),
    emptyExisting,
    rollback,
  ]);
  denied(await scope.chat.completeManagementProposal(completion(updateDraft)), "INVALID_INPUT");
  scope.done();
  const refs = fixture([...completionStart, rollback]);
  denied(
    await refs.chat.completeManagementProposal(completion(updateDraft, [ref])),
    "INVALID_INPUT",
  );
  refs.done();
});

test("exact update completion replay returns its later receipt without current-version validation or writes", async () => {
  const f = fixture([
    begin,
    chatLock,
    response("completed"),
    { sql: /^select "draft" from "management_proposals"/, rows: [[updateDraft]] },
    view(updateDraft, updateReceipt()),
    updateTarget(8),
    commit,
  ]);
  assert.equal(
    data(await f.chat.completeManagementProposal(completion(updateDraft))).managementProposal
      .status,
    "confirmed",
  );
  assert.ok(!f.calls.some((s) => /^(insert|update|delete)/.test(s)));
  f.done();
});

test("read-only update recovery exposes minimum current target fields and hides unavailable IDs", async () => {
  for (const available of [false, true]) {
    const f = fixture([
      { sql: /^begin isolation level repeatable read read only$/ },
      view(updateDraft),
      available ? updateTarget(3, "todo") : { ...updateTarget(), rows: [] },
      commit,
    ]);
    const result = data(await f.chat.getManagementProposal({ proposalId }));
    assert.equal(result.draft.kind, "update_task");
    if (result.draft.kind !== "update_task") throw new Error("Wrong kind");
    assert.equal(result.draft.target.state, available ? "available" : "unavailable");
    if (!available)
      assert.doesNotMatch(JSON.stringify(result), new RegExp(taskId + "|" + projectId));
    f.done();
  }
});
