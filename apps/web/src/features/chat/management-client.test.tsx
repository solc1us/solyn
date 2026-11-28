import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatSession, ChatSessions, type ChatView } from "./client-state";
import { ManagementPreview } from "./management-preview";
import {
  managementProposalViewSchema,
  type ManagementProposalView,
  type ManagementConfirmation,
} from "./management-contracts";
import {
  originalManagementEdit,
  managementPayload,
  revokeManagement,
  type ManagementEdit,
} from "./management-client";
import { consumeChatResponse, managementMatchesMessage, TransportFailure } from "./transport";

const conversationId = "11111111-1111-4111-8111-111111111111",
  turnId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333",
  assistantId = "44444444-4444-4444-8444-444444444444";
const proposalId = "55555555-5555-4555-8555-555555555555",
  noteId = "66666666-6666-4666-8666-666666666666",
  taskId = "77777777-7777-4777-8777-777777777777";
const now = new Date("2026-01-01T00:00:00Z");
const ok = <T,>(data: T) => ({ ok: true as const, data });
const unavailable = () => ({
  ok: false as const,
  error: { code: "UNAVAILABLE" as const, message: "safe" },
});
const project: ManagementProposalView = {
  id: proposalId,
  sourceMessageId: assistantId,
  conversationId,
  turnId,
  kind: "create_project",
  status: "proposed",
  scopedProject: null,
  receipt: null,
  draft: { schemaVersion: 1, kind: "create_project", name: "Orion", description: null },
};
function tasks(fixed = false, retrieved = false): ManagementProposalView {
  return {
    ...project,
    kind: "create_tasks",
    scopedProject: fixed ? { id: projectId, name: "Orion" } : null,
    draft: {
      schemaVersion: 1,
      kind: "create_tasks",
      scopedProjectId: fixed ? projectId : null,
      items: [1, 2].map((itemId) => ({
        itemId,
        fields: {
          title: `Task ${itemId}`,
          description: null,
          status: "todo",
          priority: null,
          assignee: null,
          dueDate: null,
          sourceNoteId: retrieved ? noteId : null,
        },
        evidence: retrieved
          ? {
              type: "retrieved_note",
              excerptOnly: true,
              source: {
                state: "available",
                noteId,
                projectId,
                retrievedUpdatedAt: now.toISOString(),
                updatedAt: now.toISOString(),
                href: `/projects/${projectId}/notes/${noteId}`,
              },
            }
          : { type: "user_message" },
      })),
    },
  };
}
function confirmed(proposal = project): ManagementProposalView {
  return {
    ...proposal,
    status: "confirmed",
    receipt:
      proposal.kind === "create_project"
        ? {
            kind: "create_project",
            result: { state: "available", projectId, href: `/projects/${projectId}` },
          }
        : {
            kind: "create_tasks",
            results: [
              {
                itemId: 1,
                state: "available",
                taskId,
                projectId,
                href: `/tasks/${taskId}`,
                currentVersion: 1,
              },
            ],
          },
  };
}
function view(proposal = project): ChatView {
  const base = {
    conversationId,
    turnId,
    modelId: null,
    createdAt: now,
    updatedAt: now,
    sources: [],
    proposal: null,
    managementProposal: null,
  };
  return {
    conversation: {
      id: conversationId,
      projectId: proposal.scopedProject?.id ?? null,
      title: "Chat",
      createdAt: now,
      updatedAt: now,
    },
    project: proposal.scopedProject,
    messages: [
      { ...base, id: noteId, role: "user", status: "completed", content: "Prepare draft" },
      {
        ...base,
        id: assistantId,
        role: "assistant",
        status: "completed",
        content: "Draft ready",
        managementProposal: proposal,
      },
    ],
    pendingTurn: null,
  };
}
type Dependencies = ConstructorParameters<typeof ChatSession>[0];
function fixture(proposal = project, overrides: Partial<Dependencies> = {}) {
  const writes: unknown[] = [],
    reads: unknown[] = [],
    recoveries: unknown[] = [];
  const session = new ChatSession(
    {
      create: async () => ok(view(proposal).conversation),
      read: async (input) => {
        reads.push(input);
        return ok(view(proposal));
      },
      fetch: async () => new Response(null, { status: 503 }),
      uuid: () => turnId,
      created: () => {},
      changed: () => {},
      confirmManagement: async (input) => {
        writes.push(input);
        return ok({ proposal: confirmed(proposal), replayed: false });
      },
      recoverManagement: async (input) => {
        recoveries.push(input);
        return unavailable();
      },
      ...overrides,
    },
    { conversationId, project: proposal.scopedProject, initial: ok(view(proposal)) },
  );
  return { session, writes, reads, recoveries };
}
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const attempt = { conversationId, turnId, content: "Prepare draft" };
const signal = new AbortController().signal;
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function stream(proposal: unknown, extras: object = {}) {
  return new Response(
    frame("start", attempt) +
      frame("text-delta", { text: "Draft ready" }) +
      frame("finish", {
        turnId,
        messageId: assistantId,
        status: "completed",
        persisted: true,
        managementProposal: proposal,
        ...extras,
      }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

test("management transport accepts separate finish and replay fields with exact message identities", async () => {
  const outcome = await consumeChatResponse(stream(project), attempt, () => {}, signal);
  assert.equal(outcome.kind, "finish");
  if (outcome.kind !== "finish") throw new Error("wrong kind");
  assert.equal(outcome.proposal, null);
  assert.deepEqual(outcome.managementProposal, project);
  const messages = view().messages;
  const replay = await consumeChatResponse(
    Response.json({
      ok: true,
      replayed: true,
      user: messages[0],
      assistant: messages[1],
      abandoned: false,
      proposal: null,
      managementProposal: project,
    }),
    attempt,
    () => {},
    signal,
  );
  assert.equal(replay.kind, "replay");
  if (replay.kind !== "replay") throw new Error("wrong kind");
  assert.deepEqual(replay.assistant.managementProposal, project);
});

for (const [label, mutate] of [
  ["message", (p: ManagementProposalView) => ({ ...p, sourceMessageId: noteId })],
  ["conversation", (p: ManagementProposalView) => ({ ...p, conversationId: projectId })],
  ["turn", (p: ManagementProposalView) => ({ ...p, turnId: projectId })],
  ["status receipt", (p: ManagementProposalView) => ({ ...p, status: "confirmed" })],
  ["wrong kind", (p: ManagementProposalView) => ({ ...p, kind: "update_task" })],
  [
    "extra private receipt",
    (p: ManagementProposalView) => ({
      ...confirmed(p),
      receipt: { ...confirmed(p).receipt, approved: { name: "private" } },
    }),
  ],
] as const)
  test(`management transport denies forged ${label}`, async () => {
    await assert.rejects(
      consumeChatResponse(stream(mutate(project)), attempt, () => {}, signal),
      TransportFailure,
    );
  });

test("management transport rejects mixed note and management proposals and unsafe result links", async () => {
  const note = {
    id: taskId,
    sourceMessageId: assistantId,
    conversationId,
    turnId,
    status: "proposed",
    draft: { title: "Note", content: "Text", projectHint: null, noteDate: null },
    scopedProject: null,
    receipt: null,
  };
  await assert.rejects(
    consumeChatResponse(stream(project, { proposal: note }), attempt, () => {}, signal),
    TransportFailure,
  );
  const bad = {
    ...confirmed(),
    receipt: {
      kind: "create_project",
      result: { state: "available", projectId, href: "https://foreign.example" },
    },
  };
  await assert.rejects(
    consumeChatResponse(stream(bad), attempt, () => {}, signal),
    TransportFailure,
  );
});

test("management history validates fixed scope, item IDs, receipt subset/results and source identity", () => {
  for (const bad of [
    { ...project, scopedProject: { id: projectId, name: "Foreign" } },
    { ...tasks(true), draft: { ...tasks(true).draft, scopedProjectId: noteId } },
    {
      ...tasks(),
      draft: {
        ...tasks().draft,
        items: [{ itemId: 3, fields: {}, evidence: { type: "user_message" } }],
      },
    },
  ])
    assert.deepEqual(fixture(bad as ManagementProposalView).session.getSnapshot().messages, []);
  const good = tasks(true, true);
  assert.equal(managementProposalViewSchema.safeParse(good).success, true);
  assert.equal(managementMatchesMessage(good, view(good).messages[1]!, projectId), true);
  const confirmedTasks = confirmed(tasks());
  if (confirmedTasks.receipt?.kind !== "create_tasks") throw new Error("wrong kind");
  const duplicate = {
    ...confirmedTasks,
    receipt: {
      ...confirmedTasks.receipt,
      results: [...confirmedTasks.receipt.results, ...confirmedTasks.receipt.results],
    },
  };
  assert.deepEqual(fixture(duplicate).session.getSnapshot().messages, []);
});

test("management first confirmation uses edited project values; duplicate click is suppressed until commit acknowledgement", async () => {
  const pending =
    deferred<ReturnType<typeof ok<{ proposal: ManagementProposalView; replayed: boolean }>>>();
  const writes: unknown[] = [];
  const { session } = fixture(project, {
    confirmManagement: async (payload) => {
      writes.push(payload);
      return pending.promise;
    },
  });
  session.editManagement(proposalId, {
    kind: "create_project",
    name: " Edited ",
    description: "Approved description",
  });
  assert.equal(session.hasProposalChanges, true);
  const saving = session.confirmManagement(proposalId);
  assert.equal(session.getSnapshot().managementSaves[proposalId]?.phase, "saving");
  await session.confirmManagement(proposalId);
  assert.equal(writes.length, 1);
  assert.equal(session.getSnapshot().messages[1]?.managementProposal?.status, "proposed");
  pending.resolve(ok({ proposal: confirmed(), replayed: false }));
  await saving;
  assert.deepEqual(writes, [
    { proposalId, kind: "create_project", name: "Edited", description: "Approved description" },
  ]);
  assert.equal(session.getSnapshot().messages[1]?.managementProposal?.status, "confirmed");
  assert.deepEqual(session.getSnapshot().managementEdits, {});
  assert.deepEqual(session.getSnapshot().managementSaves, {});
  await session.confirmManagement(proposalId);
  assert.equal(writes.length, 1);
});

test("management task selection requires explicit Main project, selected valid subset and unchanged compatible evidence", async () => {
  const proposal = tasks(false, true);
  const { session, writes } = fixture(proposal);
  await session.confirmManagement(proposalId);
  assert.equal(writes.length, 0);
  const edit = originalManagementEdit(proposal);
  if (edit.kind !== "create_tasks") throw new Error("wrong kind");
  edit.projectId = projectId;
  edit.items[1]!.selected = false;
  edit.items[1]!.fields.title = "";
  edit.items[0]!.fields = {
    ...edit.items[0]!.fields,
    title: "Approved task",
    description: "Edit",
    priority: "high",
    assignee: "Dina",
    dueDate: "2026-03-01",
    sourceNoteId: null,
  };
  session.editManagement(proposalId, edit);
  await session.confirmManagement(proposalId);
  assert.deepEqual(writes, [
    {
      proposalId,
      kind: "create_tasks",
      projectId,
      items: [{ itemId: 1, fields: edit.items[0]!.fields }],
    },
  ]);
  const fixed = tasks(true, true),
    fixedEdit = originalManagementEdit(fixed);
  if (fixedEdit.kind !== "create_tasks") throw new Error("wrong kind");
  fixedEdit.projectId = noteId;
  assert.equal(managementPayload(fixed, fixedEdit), null);
  fixedEdit.projectId = projectId;
  fixedEdit.items[0]!.fields.sourceNoteId = taskId;
  assert.equal(managementPayload(fixed, fixedEdit), null);
  fixedEdit.items[0]!.fields.sourceNoteId = null;
  const stale = structuredClone(fixed);
  if (
    stale.draft.kind !== "create_tasks" ||
    stale.draft.items[0]!.evidence.type !== "retrieved_note" ||
    stale.draft.items[0]!.evidence.source.state !== "available"
  )
    throw new Error("wrong kind");
  stale.draft.items[0]!.evidence.source.updatedAt = "2026-02-01T00:00:00.000Z";
  assert.equal(managementPayload(stale, fixedEdit), null);
  assert.equal(managementPayload(revokeManagement(fixed), fixedEdit), null);
});

test("management uncertain acknowledgement locks exact canonical payload, recovers read-only, and requires explicit same-payload retry", async () => {
  const writes: unknown[] = [],
    recoveries: unknown[] = [];
  let canRead = false;
  const { session } = fixture(project, {
    confirmManagement: async (payload) => {
      writes.push(payload);
      if (writes.length === 1) throw new Error("lost acknowledgement");
      return ok({ proposal: confirmed(), replayed: true });
    },
    recoverManagement: async (input) => {
      recoveries.push(input);
      return canRead ? ok(project) : unavailable();
    },
  });
  session.editManagement(proposalId, {
    kind: "create_project",
    name: "Approved once",
    description: "Exact description",
  });
  await session.confirmManagement(proposalId);
  assert.equal(writes.length, 1);
  assert.equal(recoveries.length, 1);
  assert.equal(session.getSnapshot().managementSaves[proposalId]?.phase, "uncertain");
  session.editManagement(proposalId, {
    kind: "create_project",
    name: "Changed after submit",
    description: "",
  });
  await session.confirmManagement(proposalId);
  assert.equal(writes.length, 1);
  canRead = true;
  await session.recoverManagement(proposalId);
  assert.equal(session.getSnapshot().managementSaves[proposalId]?.phase, "retry");
  assert.equal(writes.length, 1);
  await session.confirmManagement(proposalId);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.equal(session.getSnapshot().managementReceipts[proposalId]?.status, "confirmed");
});

test("management uncertain commit recovery finds original receipt without automatic write retry", async () => {
  let writes = 0,
    reads = 0;
  const { session } = fixture(project, {
    confirmManagement: async () => {
      writes++;
      return unavailable();
    },
    recoverManagement: async () => {
      reads++;
      return ok(confirmed());
    },
  });
  await session.confirmManagement(proposalId);
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.equal(session.getSnapshot().managementReceipts[proposalId]?.status, "confirmed");
  assert.deepEqual(session.getSnapshot().managementSaves, {});
  await session.confirmManagement(proposalId);
  assert.equal(writes, 1);
});

for (const code of ["INVALID_INPUT", "UNAUTHENTICATED"] as const)
  test(`management definite ${code} denial retains editable local input and never claims success`, async () => {
    const { session } = fixture(project, {
      confirmManagement: async () => ({ ok: false, error: { code, message: "safe" } }),
    });
    session.editManagement(proposalId, {
      kind: "create_project",
      name: "Keep edits",
      description: "Local",
    });
    await session.confirmManagement(proposalId);
    assert.equal(session.getSnapshot().managementSaves[proposalId]?.phase, "error");
    assert.equal(session.getSnapshot().managementReceipts[proposalId], undefined);
    assert.equal(session.getSnapshot().managementEdits[proposalId]?.kind, "create_project");
  });

test("management foreign/conflicting confirmation acknowledgement stays uncertain, never attaches to the wrong message", async () => {
  const { session } = fixture(project, {
    confirmManagement: async () =>
      ok({ proposal: { ...confirmed(), sourceMessageId: noteId }, replayed: false }),
  });
  await session.confirmManagement(proposalId);
  assert.equal(session.getSnapshot().managementReceipts[proposalId], undefined);
  assert.equal(session.getSnapshot().managementSaves[proposalId]?.phase, "uncertain");
  assert.equal(session.getSnapshot().messages[1]?.managementProposal?.status, "proposed");
});

test("management confirmed receipt stays confirmed when result is deleted, without recreation or receipt loss", async () => {
  const original = confirmed(tasks());
  let refreshed = revokeManagement(original),
    writes = 0;
  const { session } = fixture(original, {
    recoverManagement: async () => ok(refreshed),
    confirmManagement: async () => {
      writes++;
      return unavailable();
    },
  });
  await session.recoverManagement(proposalId);
  assert.equal(session.getSnapshot().messages[1]?.managementProposal?.status, "confirmed");
  assert.deepEqual(
    session.getSnapshot().messages[1]?.managementProposal?.receipt,
    refreshed.receipt,
  );
  await session.confirmManagement(proposalId);
  assert.equal(writes, 0);
  refreshed = original;
  await session.recoverManagement(proposalId);
  assert.deepEqual(session.getSnapshot().managementReceipts[proposalId]?.receipt, original.receipt);
});

test("management cached switch strips source/result links immediately and stale server props cannot restore them", () => {
  const proposal = confirmed(tasks(true, true));
  const { session } = fixture(proposal);
  const sessions = new ChatSessions();
  const same = sessions.select("project", () => session);
  same.invalidateSources();
  assert.equal(same.getSnapshot().managementReceipts[proposalId]?.status, "confirmed");
  const raw = JSON.stringify(same.getSnapshot());
  assert.doesNotMatch(raw, new RegExp(`/tasks/${taskId}|/notes/${noteId}`));
  assert.equal(
    sessions.select("project", () => {
      throw new Error("should retain cached session");
    }),
    same,
  );
  same.adopt(ok(view(proposal)));
  assert.doesNotMatch(
    JSON.stringify(same.getSnapshot()),
    new RegExp(`/tasks/${taskId}|/notes/${noteId}`),
  );
});

test("management failed history reads and delayed acknowledgements cannot restore links after invalidation", async () => {
  const pending =
    deferred<ReturnType<typeof ok<{ proposal: ManagementProposalView; replayed: boolean }>>>();
  const { session } = fixture(project, {
    confirmManagement: async () => pending.promise,
    read: async () => unavailable(),
  });
  const saving = session.confirmManagement(proposalId);
  session.invalidateSources();
  pending.resolve(ok({ proposal: confirmed(), replayed: false }));
  await saving;
  assert.equal(session.getSnapshot().managementReceipts[proposalId]?.status, "confirmed");
  assert.doesNotMatch(JSON.stringify(session.getSnapshot()), new RegExp(`/projects/${projectId}`));
  await session.reload();
  assert.equal(session.getSnapshot().managementReceipts[proposalId]?.status, "confirmed");
  assert.doesNotMatch(JSON.stringify(session.getSnapshot()), new RegExp(`/projects/${projectId}`));
});

test("management confirmation invalidates a history read begun before the committed receipt", async () => {
  const pending = deferred<ReturnType<typeof ok<ChatView>>>();
  const { session } = fixture(project, { read: async () => pending.promise });
  const reading = session.reload();
  await session.confirmManagement(proposalId);
  pending.resolve(ok(view()));
  await reading;
  assert.equal(session.getSnapshot().messages[1]?.managementProposal?.status, "confirmed");
  assert.equal(
    session.getSnapshot().managementReceipts[proposalId]?.receipt?.kind,
    "create_project",
  );
});

test("management reload restores unconfirmed original edits but never unlocks an uncertain approval", async () => {
  const { session } = fixture();
  session.editManagement(proposalId, {
    kind: "create_project",
    name: "Local edit",
    description: "",
  });
  await session.reload();
  assert.deepEqual(session.getSnapshot().managementEdits, {});
  const uncertain = fixture(project, { confirmManagement: async () => unavailable() }).session;
  await uncertain.confirmManagement(proposalId);
  const payload = uncertain.getSnapshot().managementSaves[proposalId]?.payload;
  await uncertain.reload();
  assert.deepEqual(uncertain.getSnapshot().managementSaves[proposalId]?.payload, payload);
  assert.equal(uncertain.getSnapshot().managementSaves[proposalId]?.phase, "uncertain");
});

test("management retired session ignores late acknowledgement and cannot recreate receipts", async () => {
  const pending =
    deferred<ReturnType<typeof ok<{ proposal: ManagementProposalView; replayed: boolean }>>>();
  const { session } = fixture(project, { confirmManagement: async () => pending.promise });
  const saving = session.confirmManagement(proposalId);
  session.retire();
  pending.resolve(ok({ proposal: confirmed(), replayed: false }));
  await saving;
  assert.deepEqual(session.getSnapshot().managementReceipts, {});
  assert.deepEqual(session.getSnapshot().managementSaves, {});
  assert.deepEqual(session.getSnapshot().messages, []);
});

function preview(proposal = project, extra: Partial<Parameters<typeof ManagementPreview>[0]> = {}) {
  return renderToStaticMarkup(
    <ManagementPreview
      proposal={proposal}
      change={() => {}}
      save={() => {}}
      recover={() => {}}
      loadProjects={async () => ok([])}
      {...extra}
    />,
  );
}

test("management previews distinguish draft from confirmed state and show editable optional task fields", () => {
  const main = preview();
  assert.match(main, /Project draft — not saved as a project/);
  assert.match(main, /Create project/);
  assert.match(main, /separate draft and confirmation/);
  const task = preview(tasks());
  assert.match(task, /Target project \(required\)/);
  assert.match(task, /Select a project explicitly/);
  assert.match(task, /Create 2 tasks/);
  for (const label of [
    "Title",
    "Description (optional)",
    "Status",
    "Priority (optional)",
    "PIC (optional)",
    "Due date (optional)",
  ])
    assert.ok(task.includes(label));
  assert.match(task, /min="0001-01-01"/);
  assert.match(task, /max="9999-12-31"/);
  assert.doesNotMatch(task, /type="submit"[^>]*>(?:[^<]*Save note)/);
  const fixed = preview(tasks(true, true));
  assert.match(fixed, /Project: Orion \(fixed\)/);
  assert.doesNotMatch(fixed, /Select a project explicitly/);
  assert.match(fixed, /bounded retrieved excerpt, not a full-note review/);
  assert.match(fixed, /Keep source-note link/);
  assert.match(fixed, new RegExp(`/projects/${projectId}/notes/${noteId}`));
});

test("management confirmed unavailable receipt offers no create/recreate controls or leaked result URLs", () => {
  const html = preview(revokeManagement(confirmed(tasks(true, true))));
  assert.match(html, /Selected task creation confirmed/);
  assert.match(html, /Task 1 unavailable/);
  assert.match(html, /Refresh availability/);
  assert.doesNotMatch(html, /Create project|Create 2 tasks|Retry same approval/);
  assert.doesNotMatch(html, new RegExp(`/tasks/${taskId}|/notes/${noteId}`));
  assert.match(html, /not the final approved values/);
});

test("management uncertain preview displays only submitted values and explicitly guarded same-payload retry", () => {
  const payload: ManagementConfirmation = {
    proposalId,
    kind: "create_project",
    name: "Submitted exact",
    description: "Submitted description",
  };
  const edit: ManagementEdit = {
    kind: "create_project",
    name: "Unsubmitted edit",
    description: "",
  };
  const html = preview(project, {
    edit,
    saveState: { phase: "uncertain", payload, proposal: project, issue: "UNAVAILABLE" },
  });
  assert.match(html, /Submitted exact/);
  assert.doesNotMatch(html, /Unsubmitted edit/);
  assert.match(html, /Creation unconfirmed/);
  assert.match(html, /Check creation status/);
  assert.match(html, /<fieldset disabled=""/);
  const retry = preview(project, {
    edit,
    saveState: { phase: "retry", payload, proposal: project, issue: null },
  });
  assert.match(retry, /Retry same approval/);
  assert.match(retry, /Only the same approval/);
});

test("management streamed finish and persisted replay hydrate the same separate cached field, never auto-confirm", async () => {
  for (const replay of [false, true]) {
    const { session, writes } = fixture(project, {
      fetch: async () =>
        replay
          ? Response.json({
              ok: true,
              replayed: true,
              user: view().messages[0],
              assistant: view().messages[1],
              abandoned: false,
              proposal: null,
              managementProposal: project,
            })
          : stream(project),
    });
    session.setDraft(attempt.content);
    await session.submit();
    assert.equal(session.getSnapshot().messages.at(-1)?.managementProposal?.id, proposalId);
    assert.equal(session.getSnapshot().messages.at(-1)?.proposal, null);
    assert.equal(session.getSnapshot().needsReconcile, false);
    assert.deepEqual(writes, []);
  }
});

test("management uncertain finalization recovers original proposal from history without another inference", async () => {
  let inferences = 0,
    historyReads = 0;
  const { session, writes } = fixture(project, {
    fetch: async () => {
      inferences++;
      return new Response(
        frame("start", attempt) +
          frame("text-delta", { text: "Provisional draft" }) +
          frame("error", { code: "PERSISTENCE_FAILED", persistence: "unconfirmed" }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    read: async () => {
      historyReads++;
      return ok(view());
    },
  });
  session.setDraft(attempt.content);
  await session.submit();
  assert.equal(inferences, 1);
  assert.equal(historyReads, 1);
  assert.equal(session.getSnapshot().messages.at(-1)?.managementProposal?.id, proposalId);
  assert.equal(session.getSnapshot().messages.at(-1)?.persisted, true);
  assert.equal(session.getSnapshot().needsReconcile, false);
  assert.deepEqual(writes, []);
});

test("management provisional text or failed history cannot materialize an actionable preview", async () => {
  const { session, writes } = fixture(project, {
    fetch: async () =>
      new Response(
        frame("start", attempt) + frame("text-delta", { text: "Created project successfully" }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    read: async () => unavailable(),
  });
  session.setDraft(attempt.content);
  await session.submit();
  assert.equal(session.getSnapshot().needsReconcile, true);
  assert.ok(!session.getSnapshot().messages.at(-1)?.managementProposal);
  await session.confirmManagement(proposalId);
  assert.deepEqual(writes, []);
});

test("management out-of-page uncertain approval recovers by ID without overwriting local unrelated history", async () => {
  const empty = { ...view(), messages: [] };
  let found = false;
  const { session } = fixture(project, {
    confirmManagement: async () => unavailable(),
    recoverManagement: async () => (found ? ok(confirmed()) : unavailable()),
    read: async () => ok(empty),
  });
  session.editManagement(proposalId, {
    kind: "create_project",
    name: "Edited original",
    description: "",
  });
  await session.confirmManagement(proposalId);
  const payload = session.getSnapshot().managementSaves[proposalId]!.payload;
  await session.reload(false, false);
  assert.deepEqual(session.getSnapshot().messages, []);
  assert.deepEqual(session.getSnapshot().managementSaves[proposalId]?.payload, payload);
  found = true;
  await session.recoverManagement(proposalId);
  assert.equal(session.getSnapshot().managementReceipts[proposalId]?.status, "confirmed");
  assert.deepEqual(session.getSnapshot().messages, []);
});

test("management a stale confirmed projection cannot change the durable selected result set", async () => {
  const proposal = confirmed(tasks());
  const altered = {
    ...proposal,
    receipt: {
      kind: "create_tasks" as const,
      results: [
        {
          itemId: 2,
          state: "available" as const,
          taskId,
          projectId,
          href: `/tasks/${taskId}`,
          currentVersion: 2,
        },
      ],
    },
  };
  const { session } = fixture(proposal, { recoverManagement: async () => ok(altered) });
  await session.recoverManagement(proposalId);
  const receipt = session.getSnapshot().managementReceipts[proposalId]?.receipt;
  assert.equal(receipt?.kind, "create_tasks");
  if (receipt?.kind !== "create_tasks") throw new Error("wrong receipt");
  assert.equal(receipt.results[0]!.itemId, 1);
  assert.equal(receipt.results[0]!.state, "unavailable");
});
