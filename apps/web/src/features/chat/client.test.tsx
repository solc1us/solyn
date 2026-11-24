import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Textarea } from "@solyn/ui/components/textarea";
import { cn } from "@solyn/ui/lib/utils";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ChatSession,
  ChatSessions,
  conversationTitle,
  messageStatus,
  isGenerationFailure,
  replyFailureNotice,
  shouldSend,
  type ChatView,
} from "./client-state";
import { MessageContent, ReplyFailure } from "./message-content";
import { ConversationRow } from "./conversation-row";
import { RetrievedNotes } from "./retrieved-notes";
import { ProposalPreview } from "./proposal-preview";
import { PROPOSAL_MESSAGE, type ProposalView, type SourceView } from "./contracts";
import {
  consumeChatResponse,
  sourcesMatchMessage,
  parseSSE,
  TransportFailure,
  type Attempt,
  type WireMessage,
} from "./transport";

const conversationId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333";
const assistantId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-01-01T00:00:00Z");
const attempt: Attempt = { conversationId, turnId, content: "  Original message\n" };
const conversation = {
  id: conversationId,
  projectId: null as string | null,
  title: "Chat",
  createdAt: now,
  updatedAt: now,
};
const ok = <T,>(data: T) => ({ ok: true as const, data });
const unavailable = () => ({
  ok: false as const,
  error: { code: "UNAVAILABLE" as const, message: "safe" },
});
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const start = () => frame("start", { conversationId, turnId });
const delta = (text = "Answer 💙") => frame("text-delta", { text });
const finish = (persisted = true) =>
  frame("finish", { turnId, messageId: assistantId, status: "completed", persisted });
function bytes(text: string, size = 1) {
  const encoded = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += size)
        controller.enqueue(encoded.slice(offset, offset + size));
      controller.close();
    },
  });
}
function sse(text: string, size = 1) {
  return new Response(bytes(text, size), {
    headers: { "Content-Type": "text/event-stream; charset=utf-8" },
  });
}
function pair(
  status: WireMessage["status"] = "completed",
  content = "Answer",
  id = turnId,
): WireMessage[] {
  return [
    {
      id: crypto.randomUUID(),
      conversationId,
      turnId: id,
      role: "user",
      content: attempt.content,
      status: "completed",
    },
    { id: assistantId, conversationId, turnId: id, role: "assistant", content, status },
  ];
}
type Dependencies = ConstructorParameters<typeof ChatSession>[0];
function fixture(
  options: {
    existing?: boolean;
    project?: boolean;
    initial?: ConstructorParameters<typeof ChatSession>[1]["initial"];
    fetch?: (attempt: Attempt, signal: AbortSignal) => Promise<Response>;
    read?: Dependencies["read"];
    create?: Dependencies["create"];
    confirm?: Dependencies["confirm"];
    recoverProposal?: Dependencies["recoverProposal"];
  } = {},
) {
  const sent: Attempt[] = [];
  const creates: unknown[] = [];
  const confirms: unknown[] = [];
  const recoveries: unknown[] = [];
  const reads: unknown[] = [];
  const created: string[] = [];
  let ids = 0;
  let changes = 0;
  let database: WireMessage[] = [];
  const scope = options.project ? { id: projectId, name: "Authorized project" } : null;
  const metadata = { ...conversation, projectId: scope?.id ?? null };
  function view(): ChatView {
    const pending = database.find((m) => m.role === "assistant" && m.status === "pending");
    return {
      conversation: metadata,
      project: scope,
      messages: database.map((m) => ({
        ...m,
        proposal: m.proposal ?? null,
        sources: m.sources ?? [],
        modelId: m.role === "assistant" ? "test-model" : null,
        createdAt: now,
        updatedAt: now,
      })),
      pendingTurn: pending ? { turnId: pending.turnId, abandoned: false } : null,
    };
  }
  function save(status: WireMessage["status"], text = "Answer 💙", id = turnId) {
    database = [...database.filter((m) => m.turnId !== id), ...pair(status, text, id)];
  }
  const session = new ChatSession(
    {
      create: async (input) => {
        creates.push(input);
        return options.create ? options.create(input) : ok(metadata);
      },
      confirm: async (input) => {
        confirms.push(input);
        return options.confirm ? options.confirm(input) : unavailable();
      },
      recoverProposal: async (input) => {
        recoveries.push(input);
        return options.recoverProposal ? options.recoverProposal(input) : unavailable();
      },
      read: async (input) => {
        reads.push(input);
        return options.read ? options.read(input) : ok(view());
      },
      fetch: async (_url, init) => {
        const value = JSON.parse(init!.body as string) as Attempt;
        sent.push(value);
        if (options.fetch) return options.fetch(value, init!.signal as AbortSignal);
        save("completed", "Answer 💙", value.turnId);
        return sse(
          frame("start", value) +
            delta() +
            frame("finish", {
              turnId: value.turnId,
              messageId: assistantId,
              status: "completed",
              persisted: true,
            }),
        );
      },
      uuid: () => {
        ids++;
        return ids === 1 ? turnId : crypto.randomUUID();
      },
      created: (id) => created.push(id),
      changed: () => {
        changes++;
      },
    },
    {
      conversationId: options.existing ? conversationId : undefined,
      project: scope,
      initial: options.initial ?? (options.existing ? ok(view()) : undefined),
    },
  );
  return {
    session,
    confirms,
    recoveries,
    sent,
    creates,
    reads,
    created,
    view,
    save,
    ids: () => ids,
    changes: () => changes,
  };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Promise.resolve();
  }
  assert.fail("Expected asynchronous state transition");
}

const sourceNoteId = "88888888-8888-4888-8888-888888888888";
const source: SourceView = {
  ordinal: 1,
  state: "available",
  noteId: sourceNoteId,
  projectId,
  projectName: "Authorized <script>project</script>",
  title: "Current <script>alert('title')</script>",
  href: `/projects/${projectId}/notes/${sourceNoteId}`,
  retrievedUpdatedAt: now.toISOString(),
  updatedAt: now.toISOString(),
};
function sourceHistory(sources: SourceView[] = [source]): ChatView {
  const base = fixture({ existing: true, project: true }).view();
  return {
    ...base,
    messages: pair().map((message) => ({
      ...message,
      sources: message.role === "assistant" ? sources : [],
      proposal: null,
      modelId: message.role === "assistant" ? "test-model" : null,
      createdAt: now,
      updatedAt: now,
    })),
  };
}
const sourceFinish = (sources: unknown = [source], messageId = assistantId) =>
  frame("finish", {
    turnId,
    messageId,
    status: "completed",
    persisted: true,
    sources,
  });

test("sources finish and JSON replay validate message identity while legacy omitted fields default empty", async () => {
  const outcome = await consumeChatResponse(
    sse(start() + delta() + sourceFinish()),
    attempt,
    () => {},
    new AbortController().signal,
  );
  assert.equal(outcome.kind, "finish");
  if (outcome.kind === "finish") assert.deepEqual(outcome.sources, [source]);
  const view = sourceHistory();
  const replay = await consumeChatResponse(
    Response.json({
      ok: true,
      replayed: true,
      abandoned: false,
      user: view.messages[0],
      assistant: view.messages[1],
    }),
    attempt,
    () => {},
    new AbortController().signal,
  );
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") assert.deepEqual(replay.assistant.sources, [source]);
  const legacy = await consumeChatResponse(
    sse(start() + delta() + finish()),
    attempt,
    () => {},
    new AbortController().signal,
  );
  if (legacy.kind === "finish") assert.deepEqual(legacy.sources, []);
});

test("sources transport rejects excessive, malformed, noncanonical or misattributed projections", async () => {
  for (const sources of [
    [{ ...source, ordinal: 2 }],
    [{ ...source, href: "https://foreign.invalid" }],
    [{ ...source, noteId: "fake" }],
    [{ ...source, updatedAt: "invalid" }],
    [{ ...source, projectName: undefined }],
    [{ ...source, projectName: " " }],
    [{ ...source, projectName: "x".repeat(201) }],
    [{ ordinal: 1, state: "unavailable", projectName: "Hidden project" }],
    [{ ordinal: 1, state: "unavailable", noteId: sourceNoteId }],
    Array.from({ length: 6 }, (_, index) => ({ ordinal: index + 1, state: "unavailable" })),
    [source, { ...source, ordinal: 2 }],
  ]) {
    await assert.rejects(
      consumeChatResponse(
        sse(start() + delta() + sourceFinish(sources)),
        attempt,
        () => {},
        new AbortController().signal,
      ),
      (error) => error instanceof TransportFailure && error.code === "PROTOCOL",
    );
  }
  const view = sourceHistory();
  for (const messages of [
    { user: { ...view.messages[0], sources: [source] }, assistant: view.messages[1] },
    { user: view.messages[0], assistant: { ...view.messages[1], status: "failed" } },
    { user: view.messages[0], assistant: { ...view.messages[1], turnId: crypto.randomUUID() } },
    { user: view.messages[0], assistant: { ...view.messages[1], id: view.messages[0]!.id } },
  ])
    await assert.rejects(
      consumeChatResponse(
        Response.json({ ok: true, replayed: true, abandoned: false, ...messages }),
        attempt,
        () => {},
        new AbortController().signal,
      ),
      TransportFailure,
    );
});

test("sources a footer appears only after persisted finish and lost acknowledgement recovers via history", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const f = fixture({
    existing: true,
    project: true,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  f.session.setDraft(attempt.content);
  const sending = f.session.submit();
  await until(() => f.sent.length === 1);
  stream.enqueue(new TextEncoder().encode(start() + delta()));
  await until(() => !!f.session.getSnapshot().messages.at(-1)!.content);
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources ?? [], []);
  stream.enqueue(new TextEncoder().encode(sourceFinish()));
  stream.close();
  await sending;
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, [source]);
  assert.equal(f.session.getSnapshot().messages.at(-1)!.id, assistantId);
  const lost = fixture({
    existing: true,
    project: true,
    fetch: async () => sse(start() + delta()),
    read: async () => ok(sourceHistory()),
  });
  lost.session.setDraft(attempt.content);
  await lost.session.submit();
  assert.equal(lost.sent.length, 1);
  assert.equal(lost.reads.length, 1);
  assert.deepEqual(lost.session.getSnapshot().messages.at(-1)!.sources, [source]);
});

test("sources history revocation and authoritative empty arrays replace rather than union links", async () => {
  let latest = sourceHistory([{ ordinal: 1, state: "unavailable" }]);
  const f = fixture({
    existing: true,
    project: true,
    initial: ok(sourceHistory()),
    read: async () => ok(latest),
  });
  await f.session.reload(true);
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, [
    { ordinal: 1, state: "unavailable" },
  ]);
  latest = sourceHistory([]);
  await f.session.reload();
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, []);
  assert.equal(f.sent.length, 0);
});

test("H01 repeated render-time initialization preserves fresh sources without notifications or extra reads", () => {
  const f = fixture({ existing: true, project: true, initial: ok(sourceHistory()) });
  const sessions = new ChatSessions();
  let creates = 0;
  const initialize = () => ({
    key: conversationId,
    session: sessions.select(conversationId, () => {
      creates++;
      return f.session;
    }),
  });
  const first = initialize();
  const snapshot = first.session.getSnapshot();
  let notifications = 0;
  first.session.subscribe(() => {
    notifications++;
  });
  // React's development StrictMode invokes the lazy state initializer twice
  // with the same useRef cache, before an active session has been committed.
  const repeated = initialize();
  assert.equal(repeated.session, first.session);
  assert.deepEqual(repeated.session.getSnapshot().messages.at(-1)!.sources, [source]);
  assert.equal(repeated.session.getSnapshot(), snapshot);
  assert.equal(repeated.session.getSnapshot().needsReconcile, false);
  assert.equal(creates, 1);
  assert.equal(notifications, 0);
  assert.equal(f.reads.length, 0);
});

test("sources committed cached reactivation clears links before paint, preserves drafts and uses fresh action reads", async () => {
  let release!: (value: ReturnType<typeof ok<ChatView>>) => void;
  const f = fixture({
    existing: true,
    project: true,
    initial: ok(sourceHistory()),
    read: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  const sessions = new ChatSessions();
  sessions.select(conversationId, () => f.session);
  f.session.setDraft("Keep draft");
  // Render-time cache selection is read-only, even before an active view exists.
  sessions.select(conversationId, () => assert.fail());
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, [source]);
  // ChatScreen's committed layout effect invalidates switched sessions, before
  // paint. Its passive effect then requests a fresh action read.
  f.session.invalidateSources();
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, []);
  assert.equal(f.session.getSnapshot().needsReconcile, true);
  assert.equal(f.session.getSnapshot().draft, "Keep draft");
  const reading = f.session.reload(false, false);
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, []);
  release(ok(sourceHistory([{ ordinal: 1, state: "unavailable" }])));
  await reading;
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, [
    { ordinal: 1, state: "unavailable" },
  ]);
  assert.equal(f.sent.length, 0);
});

test("sources stale older-page reads cannot resurrect links after cached-session invalidation", async () => {
  let release!: (value: ReturnType<typeof ok<ChatView>>) => void;
  let reads = 0;
  const f = fixture({
    existing: true,
    project: true,
    initial: ok(sourceHistory()),
    read: async () =>
      ++reads === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : ok(sourceHistory([{ ordinal: 1, state: "unavailable" }])),
  });
  const observed: (SourceView[] | undefined)[] = [];
  const older = f.session.reload(true);
  f.session.invalidateSources();
  f.session.subscribe(() => observed.push(f.session.getSnapshot().messages.at(-1)!.sources));
  release(ok(sourceHistory()));
  await older;
  await until(() => reads === 2 && f.session.getSnapshot().phase === "idle");
  assert.ok(observed.every((sources) => !sources?.some((item) => item.state === "available")));
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, [
    { ordinal: 1, state: "unavailable" },
  ]);
});

test("sources stale completed route snapshots cannot restore revoked links", async () => {
  const f = fixture({
    existing: true,
    project: true,
    initial: ok(sourceHistory([])),
    read: async () => ok(sourceHistory([{ ordinal: 1, state: "unavailable" }])),
  });
  f.session.adopt(ok(sourceHistory()));
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, []);
  await until(() => f.session.getSnapshot().phase === "idle");
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, [
    { ordinal: 1, state: "unavailable" },
  ]);
});

test("sources finish rejects foreign project attribution and existing message-ID collisions", async () => {
  for (const collision of [false, true]) {
    const prior = sourceHistory([]);
    prior.messages = prior.messages.map((message) => ({ ...message, turnId: crypto.randomUUID() }));
    const f = fixture({
      existing: true,
      project: true,
      initial: ok(prior),
      read: async () => ok(prior),
      fetch: async () =>
        sse(
          start() +
            delta() +
            sourceFinish(
              collision
                ? [source]
                : [
                    {
                      ...source,
                      projectId: conversationId,
                      href: `/projects/${conversationId}/notes/${sourceNoteId}`,
                    },
                  ],
            ),
        ),
    });
    f.session.setDraft(attempt.content);
    await f.session.submit();
    assert.equal(f.session.getSnapshot().issue, "PROTOCOL");
    assert.ok(f.session.getSnapshot().messages.every((message) => !message.sources?.length));
  }
});

test("sources denied or corrupt history hides old links and blocks unsupported attribution", async () => {
  const otherView = {
    ...sourceHistory(),
    conversation: { ...sourceHistory().conversation, id: projectId },
    messages: sourceHistory().messages.map((message) => ({
      ...message,
      conversationId: projectId,
    })),
  };
  for (const read of [
    async () => unavailable(),
    async () => ok(sourceHistory([{ ...source, href: "/bad" }])),
    async () => ok(otherView),
  ]) {
    const f = fixture({ existing: true, project: true, initial: ok(sourceHistory()), read });
    await f.session.reload();
    assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, []);
    assert.equal(f.session.getSnapshot().needsReconcile, true);
  }
  for (const view of [
    otherView,
    sourceHistory([
      {
        ...source,
        projectId: conversationId,
        href: `/projects/${conversationId}/notes/${sourceNoteId}`,
      },
    ]),
  ]) {
    const f = fixture({ existing: true, initial: ok(view) });
    assert.equal(f.session.getSnapshot().needsReconcile, true);
    assert.equal(f.session.getSnapshot().messages.length, 0);
  }
});

const crossSources: SourceView[] = [
  source,
  {
    ...source,
    ordinal: 2,
    noteId: assistantId,
    projectId: conversationId,
    projectName: "Vega",
    title: "Second decision",
    href: `/projects/${conversationId}/notes/${assistantId}`,
  },
];
function generalSourceHistory(sources: SourceView[] = crossSources): ChatView {
  const view = sourceHistory(sources);
  return { ...view, conversation: { ...view.conversation, projectId: null }, project: null };
}

test("sources null scope still validates canonical references, metadata and completed assistant identity", () => {
  const message = {
    role: "assistant" as const,
    status: "completed" as const,
    sources: crossSources,
  };
  assert.equal(sourcesMatchMessage(message, null), true);
  assert.equal(sourcesMatchMessage(message, projectId), false);
  for (const sources of [
    [{ ...source, href: "/forged" }],
    [{ ...source, projectName: "" }],
    [{ ...source, projectId: "bad" }],
    [{ ...source, updatedAt: "bad" }],
    [source, { ...source, ordinal: 2 }],
  ])
    assert.equal(sourcesMatchMessage({ ...message, sources }, null), false);
  for (const patch of [{ role: "user" as const }, { status: "failed" as const }, { proposal }])
    assert.equal(sourcesMatchMessage({ ...message, ...patch }, null), false);
});

test("sources general transport accepts multi-project finish and exact-message replay", async () => {
  const view = generalSourceHistory();
  for (const response of [
    sse(start() + delta() + sourceFinish(crossSources)),
    Response.json({
      ok: true,
      replayed: true,
      abandoned: false,
      user: view.messages[0],
      assistant: view.messages[1],
    }),
  ]) {
    const outcome = await consumeChatResponse(
      response,
      attempt,
      () => {},
      new AbortController().signal,
    );
    const sources =
      outcome.kind === "finish"
        ? outcome.sources
        : outcome.kind === "replay"
          ? outcome.assistant.sources
          : undefined;
    assert.deepEqual(sources, crossSources);
  }
});

test("sources general finish survives fresh load, reload and cached-session reconciliation without stale route restoration", async () => {
  let latest = generalSourceHistory();
  const f = fixture({
    existing: true,
    read: async () => ok(latest),
    fetch: async () => sse(start() + delta() + sourceFinish(crossSources)),
  });
  f.session.setDraft(attempt.content);
  await f.session.submit();
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, crossSources);
  await f.session.reload();
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, crossSources);
  const fresh = fixture({ existing: true, initial: ok(generalSourceHistory()) });
  assert.deepEqual(fresh.session.getSnapshot().messages.at(-1)!.sources, crossSources);
  assert.equal(fresh.session.getSnapshot().needsReconcile, false);
  assert.equal(fresh.reads.length, 0);
  latest = generalSourceHistory([{ ordinal: 1, state: "unavailable" }, crossSources[1]!]);
  f.session.invalidateSources();
  f.session.adopt(ok(generalSourceHistory()));
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, []);
  await until(() => f.session.getSnapshot().phase === "idle");
  assert.deepEqual(
    f.session.getSnapshot().messages.at(-1)!.sources,
    latest.messages.at(-1)!.sources,
  );
  assert.equal(f.sent.length, 1);
});

test("sources general lost-finish recovery restores sources but denied authorization clears every project", async () => {
  let denied = false;
  const f = fixture({
    existing: true,
    fetch: async () => sse(start() + delta()),
    read: async () => (denied ? unavailable() : ok(generalSourceHistory())),
  });
  f.session.setDraft(attempt.content);
  await f.session.submit();
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, crossSources);
  assert.equal(f.sent.length, 1);
  denied = true;
  await f.session.reload();
  assert.deepEqual(f.session.getSnapshot().messages.at(-1)!.sources, []);
  assert.equal(f.session.getSnapshot().needsReconcile, true);
});

test("sources general footer labels both authorized projects and hides unavailable project metadata", () => {
  const message = { ...generalSourceHistory().messages[1]!, persisted: true };
  const html = renderToStaticMarkup(<RetrievedNotes message={message} />);
  assert.match(html, /Authorized &lt;script&gt;project/);
  assert.match(html, /Vega/);
  assert.equal((html.match(/<a /g) ?? []).length, 2);
  assert.doesNotMatch(html, /<script>/);
  const unavailableHtml = renderToStaticMarkup(
    <RetrievedNotes
      message={{ ...message, sources: [{ ordinal: 1, state: "unavailable" }, crossSources[1]!] }}
    />,
  );
  assert.doesNotMatch(unavailableHtml, /Authorized|Current|88888888/);
  assert.match(unavailableHtml, /Note unavailable/);
  assert.match(unavailableHtml, /Vega/);
});

test("sources footer escapes titles, preserves unavailable positions and does not link model citations", () => {
  const message = { ...sourceHistory().messages[1]!, persisted: true };
  const html = renderToStaticMarkup(
    <RetrievedNotes
      message={{ ...message, sources: [source, { ordinal: 2, state: "unavailable" }] }}
    />,
  );
  assert.match(html, /Retrieved notes/);
  assert.match(html, /Current &lt;script&gt;/);
  assert.match(html, /Authorized &lt;script&gt;project/);
  assert.match(html, /Note unavailable/);
  assert.match(html, /current note versions, not saved snapshots/);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.ok(html.includes(source.href));
  assert.doesNotMatch(html, /<script>/);
  for (const patch of [
    { sources: [] },
    { proposal },
    { persisted: false },
    { role: "user" as const },
    { status: "pending" as const },
    { status: "failed" as const },
    { status: "stopped" as const },
  ])
    assert.equal(renderToStaticMarkup(<RetrievedNotes message={{ ...message, ...patch }} />), "");
  const modelText = renderToStaticMarkup(
    <MessageContent content={`Invented [1] [99] [fake](${source.href}) https://evil.invalid`} />,
  );
  assert.doesNotMatch(modelText, /<a\b/);
  const footer = readFileSync(new URL("./retrieved-notes.tsx", import.meta.url), "utf8");
  assert.match(footer, /prefetch=\{false\}/);
});

// No browser, provider request or database connection is used in this file.
test("SSE decodes split UTF-8, field names, JSON and CRLF across every byte boundary", async () => {
  for (const separator of ["\n", "\r\n", "\r"]) {
    const text = (": keepalive\n\n" + start() + delta() + finish()).replaceAll("\n", separator);
    for (const size of [1, 2, 7, 100_000]) {
      const updates: unknown[] = [];
      const result = await consumeChatResponse(
        sse(text, size),
        attempt,
        (update) => updates.push(update),
        new AbortController().signal,
      );
      assert.equal(result.kind, "finish");
      assert.deepEqual(updates, [{ type: "start" }, { type: "delta", text: "Answer 💙" }]);
    }
  }
});

test("SSE handles multiline data and comments, but never dispatches a partial EOF frame", async () => {
  const result: unknown[] = [];
  for await (const event of parseSSE(
    bytes("event: test\ndata: one\ndata: two\n\n: comment\n\nevent: unfinished\ndata: lost"),
    new AbortController().signal,
  ))
    result.push(event);
  assert.deepEqual(result, [{ event: "test", data: "one\ntwo" }]);
});

test("SSE accepts large chunks containing many small frames but bounds unfinished frames", async () => {
  const response = sse(
    start() + Array.from({ length: 6000 }, () => delta("x")).join("") + finish(),
    1_000_000,
  );
  assert.equal(
    (await consumeChatResponse(response, attempt, () => {}, new AbortController().signal)).kind,
    "finish",
  );
  await assert.rejects(async () => {
    for await (const _ of parseSSE(
      bytes("data: " + "x".repeat(262_145), 300_000),
      new AbortController().signal,
    )) {
      /* no complete frame */
    }
  }, TransportFailure);
});

test("only matching persisted finish confirms a stream; false flags, wrong IDs and EOF do not", async () => {
  for (const text of [
    start() + delta(),
    start() + delta() + finish(false),
    start() +
      delta() +
      frame("finish", {
        turnId: projectId,
        messageId: assistantId,
        status: "completed",
        persisted: true,
      }),
    delta() + finish(),
    start() + delta() + finish().slice(0, -1),
    "data: invalid\n\n",
  ]) {
    await assert.rejects(
      consumeChatResponse(sse(text), attempt, () => {}, new AbortController().signal),
    );
  }
});

test("pre-stream JSON errors discard server message details; replay validates persisted identity and status", async () => {
  const error = await consumeChatResponse(
    Response.json(
      { ok: false, error: { code: "RATE_LIMITED", message: "private-SENTINEL" } },
      { status: 503 },
    ),
    attempt,
    () => {},
    new AbortController().signal,
  );
  assert.deepEqual(error, { kind: "rejected", code: "RATE_LIMITED" });
  assert.doesNotMatch(JSON.stringify(error), /SENTINEL/);
  for (const status of ["pending", "completed", "failed", "stopped"] as const) {
    const [user, assistant] = pair(status);
    const replay = await consumeChatResponse(
      Response.json({ ok: true, replayed: true, abandoned: status === "pending", user, assistant }),
      attempt,
      () => assert.fail("Replay must not emit deltas"),
      new AbortController().signal,
    );
    assert.equal(replay.kind, "replay");
  }
  const [user, assistant] = pair();
  await assert.rejects(
    consumeChatResponse(
      Response.json({
        ok: true,
        replayed: true,
        abandoned: false,
        user: { ...user, turnId: projectId },
        assistant,
      }),
      attempt,
      () => {},
      new AbortController().signal,
    ),
  );
});

test("acknowledged rename changes cached title only, while delete retires and evicts stale sessions", () => {
  const cache = new ChatSessions();
  const f = fixture({ existing: true });
  cache.select(`conversation:${conversationId}`, () => f.session);
  f.session.setDraft("Keep my current draft");
  const before = f.session.getSnapshot();
  cache.rename(conversationId, "Renamed");
  assert.deepEqual(f.session.getSnapshot(), {
    ...before,
    conversation: { ...before.conversation!, title: "Renamed" },
  });
  assert.equal(f.sent.length + f.reads.length + f.confirms.length, 0);
  cache.remove(conversationId);
  const retired = f.session.getSnapshot();
  assert.equal(retired.conversation, null);
  assert.deepEqual(retired.messages, []);
  assert.equal(retired.draft, "");
  assert.equal(f.session.canSend, false);
  assert.equal(f.session.canRetry, false);
  assert.ok(cache.isDeleted(conversationId));
  cache.rename(conversationId, "Late stale rename");
  f.session.adopt(ok(f.view()));
  assert.equal(f.session.getSnapshot().conversation, null);
  const stale = cache.select(
    `conversation:${conversationId}`,
    () => fixture({ existing: true }).session,
  );
  assert.equal(stale.getSnapshot().conversation, null);
  assert.equal(stale.canSend, false);
  const lateCreation = fixture().session;
  assert.equal(cache.promote("new:general", conversationId, lateCreation), false);
  assert.equal(lateCreation.canSend, false);
});

test("acknowledged rename survives older reads/RSC while a subsequent fresh read can update the title", async () => {
  let release!: (value: Awaited<ReturnType<Dependencies["read"]>>) => void;
  const pending = new Promise<Awaited<ReturnType<Dependencies["read"]>>>((resolve) => {
    release = resolve;
  });
  let hold = true;
  const f = fixture({ existing: true, read: async () => (hold ? pending : ok(f.view())) });
  const reading = f.session.reload();
  f.session.renameTitle(conversationId, "Acknowledged title");
  release(ok(f.view()));
  await reading;
  assert.equal(f.session.getSnapshot().conversation?.title, "Acknowledged title");
  f.session.adopt(ok(f.view()));
  await until(() => !f.session.getSnapshot().needsReconcile);
  assert.equal(f.session.getSnapshot().conversation?.title, "Acknowledged title");
  hold = false;
  await f.session.reload();
  assert.equal(f.session.getSnapshot().conversation?.title, f.view().conversation.title);
});

test("retiring an active session aborts its request and prevents late stream/read state from returning", async () => {
  let release!: (value: Response) => void;
  let signal!: AbortSignal;
  const wait = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    existing: true,
    fetch: async (_attempt, value) => {
      signal = value;
      return wait;
    },
  });
  f.session.setDraft(attempt.content);
  const sending = f.session.submit();
  await until(() => f.sent.length === 1);
  f.session.retire();
  assert.equal(signal.aborted, true);
  release(sse(start() + delta() + finish()));
  await sending;
  assert.deepEqual(f.session.getSnapshot().messages, []);
  assert.equal(f.session.getSnapshot().phase, "idle");
  assert.equal(f.reads.length, 0);
  f.session.setDraft("Cannot revive");
  await f.session.submit();
  assert.equal(f.sent.length, 1);
  let readRelease!: (view: Awaited<ReturnType<Dependencies["read"]>>) => void;
  const readWait = new Promise<Awaited<ReturnType<Dependencies["read"]>>>((resolve) => {
    readRelease = resolve;
  });
  const reading = fixture({ existing: true, read: async () => readWait });
  const loading = reading.session.reload();
  reading.session.retire();
  readRelease(ok(reading.view()));
  await loading;
  assert.equal(reading.session.getSnapshot().conversation, null);
  assert.deepEqual(reading.session.getSnapshot().messages, []);
});

test("conversation rows keep links usable, truncate titles and expose management only for Main Chat", () => {
  const props = {
    conversation,
    rename: async () => ok(conversation),
    remove: async () => ok({ id: conversationId }),
    changed: () => {},
  };
  const main = renderToStaticMarkup(
    <ConversationRow {...props} conversation={{ ...conversation, title: "<unsafe> long title" }} />,
  );
  assert.match(main, /aria-label="Manage chat: &lt;unsafe&gt; long title"/);
  assert.match(main, /aria-haspopup="menu"/);
  assert.match(main, /truncate/);
  assert.match(main, /shrink-0/);
  assert.match(main, new RegExp(`/chat\\?conversationId=${conversationId}`));
  const scoped = renderToStaticMarkup(
    <ConversationRow {...props} conversation={{ ...conversation, projectId }} showScope />,
  );
  assert.doesNotMatch(scoped, /Manage chat:/);
  assert.match(scoped, /Project Chat/);
  const row = readFileSync(new URL("./conversation-row.tsx", import.meta.url), "utf8");
  assert.match(row, /pending\.current = true/);
  assert.match(row, /window\.confirm/);
  assert.match(row, /Already-saved project notes and their revision history will be kept/);
  assert.match(row, /This cannot be undone/);
});

test("opening a new chat does not create anything; first submit creates once and sends fixed scope/title", async () => {
  for (const scoped of [false, true]) {
    const f = fixture({ project: scoped });
    assert.deepEqual(f.creates, []);
    assert.deepEqual(f.sent, []);
    f.session.setDraft(attempt.content);
    await f.session.submit();
    assert.deepEqual(f.creates, [
      { title: "Original message", projectId: scoped ? projectId : null },
    ]);
    assert.deepEqual(f.created, [conversationId]);
    assert.deepEqual(f.sent, [attempt]);
    assert.equal(f.session.getSnapshot().project?.id ?? null, scoped ? projectId : null);
    assert.equal(f.session.getSnapshot().messages.at(-1)!.persisted, true);
    assert.equal(f.session.getSnapshot().messages.at(-1)!.status, "completed");
    assert.equal(f.ids(), 1);
  }
  assert.equal(conversationTitle(" \n Hello   project \n"), "Hello project");
  assert.equal(Array.from(conversationTitle("💙".repeat(100))).length, 80);
});

test("shared input validation accepts the Unicode length boundary without losing message text", async () => {
  const f = fixture();
  const content = "💙".repeat(2000);
  f.session.setDraft(content);
  await f.session.submit();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.content, content);
});

test("invalid messages cannot create conversations or start inference", async () => {
  for (const content of [" ", "x".repeat(4001), "\0", "\ud800"]) {
    const f = fixture();
    f.session.setDraft(content);
    await f.session.submit();
    assert.deepEqual(f.creates, []);
    assert.deepEqual(f.sent, []);
    assert.equal(f.session.getSnapshot().draft, content);
  }
});

test("ownership/session denial blocks existing conversation sends and does not fall back to creation", async () => {
  for (const code of ["NOT_FOUND", "UNAUTHENTICATED", "UNAVAILABLE"] as const) {
    const f = fixture({ existing: true, initial: { ok: false, error: { code, message: "safe" } } });
    f.session.setDraft(attempt.content);
    await f.session.submit();
    assert.deepEqual(f.creates, []);
    assert.deepEqual(f.sent, []);
    assert.equal(f.session.getSnapshot().issue, code);
  }
  const denied = fixture({
    create: async () => ({ ok: false, error: { code: "NOT_FOUND", message: "safe" } }),
  });
  denied.session.setDraft(attempt.content);
  await denied.session.submit();
  assert.deepEqual(denied.sent, []);
  assert.equal(denied.session.getSnapshot().draft, attempt.content);
});

test("confirmed creation plus failed send retains conversation and retries only original turn ID/content", async () => {
  let count = 0;
  const f = fixture({
    fetch: async () => {
      count++;
      return count === 1
        ? Response.json({ ok: false, error: { code: "PROVIDER_CONFIGURATION" } }, { status: 503 })
        : sse(start() + delta() + finish());
    },
  });
  f.session.setDraft(attempt.content);
  await f.session.submit();
  assert.equal(f.session.getSnapshot().conversation!.id, conversationId);
  assert.equal(f.session.canRetry, true);
  f.session.setDraft("Next unsent draft");
  await f.session.submit(); // Cannot bypass the unresolved attempt with a new ID.
  assert.equal(f.sent.length, 1);
  await f.session.submit(true);
  assert.equal(f.creates.length, 1);
  assert.equal(f.ids(), 1);
  assert.deepEqual(f.sent, [attempt, attempt]);
  assert.equal(f.session.getSnapshot().draft, "Next unsent draft");
});

test("ambiguous creation blocks automatic recreation and preserves the original draft", async () => {
  for (const create of [
    async () => unavailable(),
    async () => {
      throw new Error("private-SENTINEL");
    },
  ]) {
    const f = fixture({ create });
    f.session.setDraft(attempt.content);
    await f.session.submit();
    await f.session.submit();
    assert.equal(f.creates.length, 1);
    assert.equal(f.sent.length, 0);
    assert.equal(f.session.getSnapshot().creationUnconfirmed, true);
    assert.equal(f.session.getSnapshot().draft, attempt.content);
    assert.equal(f.session.getSnapshot().issue, "CREATION_UNCONFIRMED");
  }
});

test("typing a future draft while creation is pending never gets erased by first send", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    create: async () => {
      await gate;
      return ok(conversation);
    },
  });
  f.session.setDraft(attempt.content);
  const sending = f.session.submit();
  f.session.setDraft("Keep my next draft");
  release();
  await sending;
  assert.equal(f.session.getSnapshot().draft, "Keep my next draft");
  assert.equal(f.sent[0]!.content, attempt.content);
});

test("duplicate submits while streaming never create another conversation, UUID or HTTP inference", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
    },
  });
  const f = fixture({
    fetch: async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
  });
  f.session.setDraft(attempt.content);
  const first = f.session.submit();
  await until(() => f.sent.length === 1);
  f.session.setDraft("Second draft");
  await f.session.submit();
  assert.equal(f.creates.length, 1);
  assert.equal(f.ids(), 1);
  assert.equal(f.sent.length, 1);
  stream.enqueue(new TextEncoder().encode(start() + delta() + finish()));
  stream.close();
  await first;
  assert.equal(f.session.getSnapshot().draft, "Second draft");
});

test("stream deltas stay provisional; only a persisted finish changes assistant status to saved", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const f = fixture({
    existing: true,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  f.session.setDraft(attempt.content);
  const sending = f.session.submit();
  await until(() => f.sent.length === 1);
  stream.enqueue(new TextEncoder().encode(start() + delta()));
  await until(() => f.session.getSnapshot().messages.at(-1)?.content === "Answer 💙");
  assert.equal(f.session.getSnapshot().messages.at(-1)!.persisted, false);
  assert.equal(messageStatus(f.session.getSnapshot().messages.at(-1)!, true), "Not yet saved");
  stream.enqueue(new TextEncoder().encode(finish()));
  stream.close();
  await sending;
  assert.equal(messageStatus(f.session.getSnapshot().messages.at(-1)!, false), "Saved");
});

test("unexpected EOF/false finish reads saved history and never fabricates persisted success", async () => {
  for (const suffix of ["", finish(false)]) {
    const f = fixture({ existing: true, fetch: async () => sse(start() + delta() + suffix) });
    f.session.setDraft(attempt.content);
    await f.session.submit();
    assert.equal(f.reads.length, 1);
    assert.equal(f.sent.length, 1);
    assert.equal(f.session.getSnapshot().messages.at(-1)!.persisted, false);
    assert.equal(f.session.getSnapshot().attempt!.turnId, turnId);
    assert.equal(f.session.canRetry, true);
    assert.notEqual(messageStatus(f.session.getSnapshot().messages.at(-1)!, false), "Saved");
  }
});

test("ambiguous EOF can be resolved only by actual saved history, not by received text", async () => {
  let f!: ReturnType<typeof fixture>;
  f = fixture({
    existing: true,
    fetch: async () => {
      f.save("completed");
      return sse(start() + delta());
    },
  });
  f.session.setDraft(attempt.content);
  await f.session.submit();
  assert.equal(f.session.getSnapshot().messages.at(-1)!.status, "completed");
  assert.equal(f.session.getSnapshot().messages.at(-1)!.persisted, true);
  assert.equal(f.session.getSnapshot().attempt, null);
  assert.equal(f.sent.length, 1);
});

test("failed, stopped, pending and completed replays cannot trigger inference retries", async () => {
  for (const status of ["pending", "failed", "stopped", "completed"] as const) {
    let f!: ReturnType<typeof fixture>;
    f = fixture({
      existing: true,
      fetch: async () => {
        f.save(status, status === "pending" ? "" : "Saved response");
        const [user, assistant] = pair(status, status === "pending" ? "" : "Saved response");
        return Response.json({ ok: true, replayed: true, abandoned: false, user, assistant });
      },
    });
    f.session.setDraft(attempt.content);
    await f.session.submit();
    assert.equal(f.sent.length, 1);
    assert.equal(f.creates.length, 0);
    assert.equal(f.session.getSnapshot().messages.at(-1)!.status, status);
    if (status === "pending") {
      f.session.setDraft("Do not infer again");
      await f.session.submit();
      await f.session.submit(true);
      assert.equal(f.sent.length, 1);
    }
  }
});

test("an abandoned JSON replay remains interrupted and never automatically retries inference", async () => {
  let f!: ReturnType<typeof fixture>;
  f = fixture({
    existing: true,
    fetch: async () => {
      f.save("pending", "");
      const [user, assistant] = pair("pending", "");
      return Response.json({ ok: true, replayed: true, abandoned: true, user, assistant });
    },
    read: async () => ok({ ...f.view(), pendingTurn: { turnId, abandoned: true } }),
  });
  f.session.setDraft(attempt.content);
  await f.session.submit();
  assert.equal(f.session.getSnapshot().pendingTurn!.abandoned, true);
  await f.session.submit(true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.ids(), 1);
});

test("live pending prevents new sends; abandoned pending allows only an explicit new message", async () => {
  const base = fixture({ existing: true });
  base.save("pending", "");
  for (const abandoned of [false, true]) {
    const view = { ...base.view(), pendingTurn: { turnId, abandoned } };
    const f = fixture({ existing: true, initial: ok(view) });
    assert.equal(f.sent.length, 0);
    f.session.setDraft("Explicit new message");
    await f.session.submit();
    assert.equal(f.sent.length, abandoned ? 1 : 0);
  }
});

test("provider failure keeps its safe reason and displays saved failed partial text", async () => {
  let f!: ReturnType<typeof fixture>;
  f = fixture({
    existing: true,
    fetch: async () => {
      f.save("failed", "Partial");
      return sse(
        start() +
          delta("Partial") +
          frame("error", {
            code: "RATE_LIMITED",
            message: "private-SENTINEL",
            persistence: "confirmed",
            status: "failed",
          }),
      );
    },
  });
  f.session.setDraft(attempt.content);
  await f.session.submit();
  assert.equal(f.session.getSnapshot().issue, "RATE_LIMITED");
  assert.equal(f.session.getSnapshot().messages.at(-1)!.status, "failed");
  assert.equal(f.session.getSnapshot().messages.at(-1)!.content, "Partial");
  assert.doesNotMatch(JSON.stringify(f.session.getSnapshot()), /SENTINEL/);
});

test("confirmed generation failures render natural UI-only inline notices, retaining partial output and exact retry protocol", async () => {
  for (const code of [
    "RATE_LIMITED",
    "PROVIDER_TIMEOUT",
    "PROVIDER_NETWORK",
    "PROVIDER_REJECTED",
    "EMPTY_RESPONSE",
    "OUTPUT_LIMIT",
  ] as const) {
    for (const partial of ["", "Partial answer"]) {
      let f!: ReturnType<typeof fixture>;
      f = fixture({
        existing: true,
        fetch: async () => {
          f.save("failed", partial);
          return sse(
            start() +
              (partial ? delta(partial) : "") +
              frame("error", {
                code,
                message: "private-provider-sentinel",
                persistence: "confirmed",
                status: "failed",
              }),
          );
        },
      });
      f.session.setDraft(attempt.content);
      await f.session.submit();
      const state = f.session.getSnapshot();
      const response = state.messages.at(-1)!;
      const notice = replyFailureNotice(
        response,
        state.needsReconcile || !!state.attempt,
        f.session.canSend,
      );
      assert.ok(notice);
      assert.equal(response.failure, code);
      assert.equal(response.content, partial); // No fabricated answer persisted or appended.
      assert.equal(state.attempt, null);
      assert.equal(f.session.canRetry, false);
      assert.equal(f.session.canSend, true);
      assert.ok(isGenerationFailure(code));
      if (partial) assert.match(notice, /incomplete/);
      if (code === "RATE_LIMITED") assert.match(notice, /temporarily busy.*try again later/);
      else if (code === "PROVIDER_TIMEOUT") assert.match(notice, /took too long.*try again/);
      else assert.match(notice, /couldn't complete.*send your message again/);
      const markup = renderToStaticMarkup(
        <>
          {partial ? <MessageContent content={partial} /> : null}
          <ReplyFailure notice={notice} />
        </>,
      );
      assert.match(markup, /data-ui-notice="failure"/);
      assert.match(markup, /aria-label="Reply status"/);
      assert.doesNotMatch(markup, /role="alert"|private-provider|border-\[#71404c\]/);
      await f.session.submit(true); // Terminal failure never re-infers the old ID.
      assert.equal(f.sent.length, 1);
      assert.equal(f.ids(), 1);
    }
  }
});

test("history-only failures never invent a provider cause, and uncertain delivery never invites new generation", async () => {
  const saved = { ...pair("failed", "Partial")[1]!, persisted: true };
  assert.match(replyFailureNotice(saved, false, true)!, /couldn't complete.*incomplete/);
  assert.doesNotMatch(replyFailureNotice(saved, false, true)!, /busy|too long/);
  assert.equal(replyFailureNotice({ ...saved, status: "pending" }, false, true), null);
  assert.equal(replyFailureNotice({ ...saved, persisted: false }, false, true), null);
  assert.equal(replyFailureNotice({ ...saved, status: "stopped" }, false, true), null);
  assert.equal(replyFailureNotice({ ...saved, role: "user" }, false, true), null);
  assert.match(replyFailureNotice(saved, true, false)!, /Reload saved history before continuing/);
  assert.doesNotMatch(replyFailureNotice(saved, true, false)!, /Please send|Please try/);
  const f = fixture({
    existing: true,
    fetch: async () =>
      sse(
        start() +
          delta("Partial") +
          frame("error", { code: "PERSISTENCE_FAILED", persistence: "unconfirmed" }),
      ),
    read: async () => unavailable(),
  });
  f.session.setDraft(attempt.content);
  await f.session.submit();
  assert.equal(f.session.getSnapshot().needsReconcile, true);
  assert.equal(f.session.canSend, false);
  assert.equal(f.session.canRetry, false);
  assert.equal(replyFailureNotice(f.session.getSnapshot().messages.at(-1)!, true, false), null);
  assert.equal(f.session.getSnapshot().messages.at(-1)!.content, "Partial");
  assert.equal(f.sent.length, 1);
  assert.ok(!isGenerationFailure("UNAUTHENTICATED") && !isGenerationFailure("PERSISTENCE_FAILED"));
});

test("confirmed terminal failure with unsuccessful history check asks for recovery, not duplicate generation", async () => {
  const f = fixture({
    existing: true,
    fetch: async () =>
      sse(
        start() +
          frame("error", { code: "RATE_LIMITED", persistence: "confirmed", status: "failed" }),
      ),
    read: async () => unavailable(),
  });
  f.session.setDraft(attempt.content);
  await f.session.submit();
  const response = f.session.getSnapshot().messages.at(-1)!;
  const notice = replyFailureNotice(response, true, f.session.canSend)!;
  assert.match(notice, /Reload saved history/);
  assert.doesNotMatch(notice, /Please send|Please try/);
  assert.equal(f.sent.length, 1);
});

test("network/read failure preserves same-ID recovery and blocks new turns until history is checked", async () => {
  const f = fixture({
    existing: true,
    fetch: async () => {
      throw new Error("private-SENTINEL");
    },
    read: async () => unavailable(),
  });
  f.session.setDraft(attempt.content);
  await f.session.submit();
  assert.equal(f.session.getSnapshot().needsReconcile, true);
  assert.equal(f.session.canSend, false);
  assert.equal(f.session.canRetry, false);
  assert.equal(f.session.getSnapshot().attempt!.turnId, turnId);
  assert.doesNotMatch(JSON.stringify(f.session.getSnapshot()), /SENTINEL/);
  await f.session.submit(true);
  assert.equal(f.sent.length, 1);
});

test("Stop aborts the active request and reconciles stopped partial output without extra inference", async () => {
  let f!: ReturnType<typeof fixture>;
  let aborted = false;
  f = fixture({
    existing: true,
    fetch: async (_attempt, signal) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          f.save("stopped", "Partial");
        },
        { once: true },
      );
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(start() + delta("Partial")));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  f.session.setDraft(attempt.content);
  const sending = f.session.submit();
  await until(() => f.session.getSnapshot().phase === "streaming");
  f.session.stop();
  await sending;
  assert.equal(aborted, true);
  assert.equal(f.sent.length, 1);
  assert.equal(f.reads.length, 1);
  assert.equal(f.session.getSnapshot().messages.at(-1)!.status, "stopped");
  assert.equal(f.session.getSnapshot().messages.at(-1)!.persisted, true);
});

test("Stop while creating waits for the confirmed ID but never starts inference or loses the draft", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    create: async () => {
      await gate;
      return ok(conversation);
    },
  });
  f.session.setDraft(attempt.content);
  const sending = f.session.submit();
  f.session.stop();
  release();
  await sending;
  assert.equal(f.creates.length, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(f.session.getSnapshot().conversation!.id, conversationId);
  assert.equal(f.session.getSnapshot().draft, attempt.content);
});

test("a pending snapshot after Stop keeps partial text provisional rather than falsely claiming stopped", async () => {
  let f!: ReturnType<typeof fixture>;
  f = fixture({
    existing: true,
    fetch: async () => {
      f.save("pending", "");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(start() + delta("Partial")));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  f.session.setDraft(attempt.content);
  const sending = f.session.submit();
  await until(() => f.session.getSnapshot().messages.at(-1)?.content === "Partial");
  f.session.stop();
  await sending;
  assert.equal(f.session.getSnapshot().messages.at(-1)!.status, "pending");
  assert.equal(f.session.getSnapshot().messages.at(-1)!.content, "Partial");
  assert.equal(f.session.getSnapshot().messages.at(-1)!.persisted, false);
  assert.equal(f.session.canSend, false);
});

test("history pages are bounded and ordered; older browsing requires latest reload before sending", async () => {
  const calls: unknown[] = [];
  const base = fixture({ existing: true });
  const makePage = (offset: number): ChatView => ({
    ...base.view(),
    messages: Array.from({ length: 50 }, (_, i) => ({
      ...base.view().messages[0],
      id: crypto.randomUUID(),
      conversationId,
      turnId: crypto.randomUUID(),
      role: "user" as const,
      status: "completed" as const,
      content: `${offset + i}`,
      modelId: null,
      createdAt: now,
      updatedAt: now,
    })),
  });
  const f = fixture({
    existing: true,
    initial: ok(makePage(0)),
    read: async (input) => {
      calls.push(input);
      return ok(makePage((input as { offset: number }).offset));
    },
  });
  for (let i = 0; i < 11; i++) await f.session.reload(true);
  assert.ok(f.session.getSnapshot().messages.length <= 500);
  assert.equal(f.session.getSnapshot().hasOlder, true);
  assert.equal((calls.at(-1) as { offset: number }).offset, 550);
  assert.equal(f.session.canSend, false);
  await f.session.reload();
  assert.equal(f.session.getSnapshot().viewingOlder, false);
  assert.equal(f.session.getSnapshot().messages.length, 50);
  assert.equal(f.session.canSend, true);
});

test("returning to cached history adopts a fresh snapshot without losing drafts or downgrading an active stream", async () => {
  const f = fixture({ existing: true });
  f.session.setDraft("Unsent draft");
  f.save("stopped", "Saved partial");
  f.session.adopt(ok(f.view()));
  assert.equal(f.session.getSnapshot().messages.at(-1)!.status, "stopped");
  assert.equal(f.session.getSnapshot().draft, "Unsent draft");
  assert.equal(f.reads.length, 0);
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const active = fixture({
    existing: true,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  active.session.setDraft(attempt.content);
  const sending = active.session.submit();
  await until(() => active.sent.length === 1);
  active.session.adopt(ok(f.view()));
  assert.equal(active.session.getSnapshot().messages.at(-1)!.persisted, false);
  stream.enqueue(new TextEncoder().encode(start() + delta() + finish()));
  stream.close();
  await sending;
  assert.equal(active.session.getSnapshot().messages.at(-1)!.status, "completed");
});

test("a route snapshot started before a confirmed finish cannot downgrade saved UI to pending or empty", async () => {
  const f = fixture({ existing: true });
  const stale = f.view();
  f.session.setDraft(attempt.content);
  await f.session.submit();
  assert.equal(f.session.getSnapshot().messages.at(-1)!.status, "completed");
  f.session.adopt(ok(stale));
  await until(() => f.session.getSnapshot().phase === "idle");
  assert.equal(f.reads.length, 1);
  assert.equal(f.session.getSnapshot().messages.at(-1)!.status, "completed");
  assert.equal(f.session.getSnapshot().messages.at(-1)!.persisted, true);
});

test("bounded chat navigation preserves drafts, promotes created conversations and never aliases New chat to old history", () => {
  const sessions = new ChatSessions();
  const first = sessions.select("new:general", () => fixture().session);
  first.setDraft("Unsent global draft");
  const project = sessions.select(`new:${projectId}`, () => fixture({ project: true }).session);
  project.setDraft("Project draft");
  assert.equal(
    sessions.select("new:general", () => assert.fail("Should retain draft")).getSnapshot().draft,
    "Unsent global draft",
  );
  sessions.promote("new:general", conversationId, first);
  assert.equal(
    sessions.select(`conversation:${conversationId}`, () =>
      assert.fail("Should retain active stream"),
    ),
    first,
  );
  assert.notEqual(
    sessions.select("new:general", () => fixture().session),
    first,
  );
  for (let i = 0; i < 12; i++) sessions.select(`extra:${i}`, () => fixture().session);
  assert.notEqual(
    sessions.select(`new:${projectId}`, () => fixture().session),
    project,
  );
});

test("Enter submits, Shift+Enter inserts newline, and IME composition cannot submit", () => {
  const enter = { key: "Enter", shiftKey: false, isComposing: false };
  assert.equal(shouldSend(enter), true);
  assert.equal(shouldSend({ ...enter, shiftKey: true }), false);
  assert.equal(shouldSend({ ...enter, isComposing: true }), false);
  assert.equal(shouldSend({ ...enter, keyCode: 229 }), false);
  assert.equal(shouldSend({ ...enter, key: "a" }), false);
});

// Test the real owner literals through cn without mounting router/session effects.
// Computed CSS, scrolling and mobile keyboard behavior remain PM acceptance checks.
function chatClasses(marker: string) {
  const source = readFileSync(new URL("./chat-screen.tsx", import.meta.url), "utf8");
  const classes = [...source.matchAll(/className="([^"]*)"/g)].map((match) => match[1]);
  const value = classes.find((entry) => entry.split(/\s+/).includes(marker));
  assert.ok(value, marker);
  return new Set(value.split(/\s+/));
}

test("chat textarea merging keeps the outer-border focus policy and 72px minimum at every input breakpoint", () => {
  const html = renderToStaticMarkup(
    <Textarea className={[...chatClasses("chat-input")].join(" ")} />,
  );
  const classes = new Set((html.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/));
  for (const expected of [
    "border-0",
    "bg-transparent",
    "shadow-none",
    "outline-none",
    "resize-none",
    "field-sizing-fixed",
    "h-[96px]",
    "overflow-y-auto",
    "rounded-[4px]",
    "px-[4px]",
    "py-[2px]",
    "min-h-[72px]",
    "max-h-[min(24dvh,180px)]",
    "text-[15px]",
    "leading-[1.6]",
    "[@media(max-width:760px)]:text-[16px]",
    "[@media(max-width:760px)]:min-h-[72px]",
    "[@media(pointer:coarse)]:min-h-[72px]",
  ])
    assert.ok(classes.has(expected), expected);
  assert.ok(
    ![...classes].some((value) => value.includes("ring-1") || value.includes("min-h-[44px]")),
  );
  assert.ok(chatClasses("chat-composer").has("focus-within:border-ring"));
});

test("popup typography/spacing remain scoped and proposal textareas use fixed scrolling surfaces", () => {
  const css = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
  assert.match(css, /\.project-chat-panel \.chat-prose\s*\{\s*font-size: 13px/);
  assert.match(css, /\.project-chat-panel \.chat-message\s*\{\s*margin-bottom: 18px/);
  const popup = readFileSync(new URL("./project-chat-popup.tsx", import.meta.url), "utf8");
  assert.ok(popup.includes("right-[max(28px,env(safe-area-inset-right))]"));
  assert.ok(popup.includes("[--project-chat-inset:28px]"));
  assert.ok(popup.includes("[@media(max-width:760px)]:[--project-chat-inset:16px]"));
  assert.ok(popup.includes("shadow-[0_20px_64px_#0006,0_4px_16px_#0004]"));
  const markup = renderToStaticMarkup(
    <ProposalPreview proposal={proposal} loadProjects={async () => ok([])} change={() => {}} />,
  );
  const textarea = markup.match(/<textarea[^>]*>/)?.[0];
  assert.ok(textarea);
  assert.ok(textarea.includes("field-sizing-fixed"));
  assert.ok(textarea.includes("resize-none") && textarea.includes("overflow-y-auto"));
  assert.ok(!textarea.includes("field-sizing-content") && !textarea.includes("resize-y"));
});

test("literal role utilities preserve assistant reading width and user alignment, bubble and responsive caps", () => {
  const source = readFileSync(new URL("./chat-screen.tsx", import.meta.url), "utf8");
  const base = source.match(/"(mb-\[28px\] min-w-0 max-w-\[760px\][^"]*)"/)?.[1];
  const user = source.match(/"(ml-auto w-fit [^"]*)"/)?.[1];
  assert.ok(base && user);
  const assistantClasses = new Set(cn(base).split(/\s+/));
  assert.ok(assistantClasses.has("max-w-[760px]"));
  assert.ok(!assistantClasses.has("ml-auto"));
  const userClasses = new Set(cn(base, user).split(/\s+/));
  for (const expected of [
    "ml-auto",
    "w-fit",
    "max-w-[min(75%,760px)]",
    "[@media(max-width:760px)]:max-w-[92%]",
    "[&_.chat-prose]:rounded-[7px]",
    "[&_.chat-prose]:bg-(--hover)",
    "[&_.chat-prose]:px-[14px]",
    "[&_.chat-prose]:py-[10px]",
  ])
    assert.ok(userClasses.has(expected), expected);
  assert.ok(!userClasses.has("max-w-[760px]"));
  assert.ok(source.includes("chat-message-${message.role}"));
  assert.match(source, /message\.role === "user"\s*&&\s*"justify-end"/);
});

test("chat owner classes keep desktop message scrolling, mobile document flow, bounded history and empty recovery collapse", () => {
  for (const [marker, expected] of [
    ["chat-screen", ["h-full", "min-h-0", "[@media(max-width:760px)]:h-auto"]],
    [
      "chat-messages",
      [
        "flex-1",
        "min-h-0",
        "overflow-auto",
        "[scrollbar-gutter:stable]",
        "[@media(max-width:760px)]:overflow-visible",
      ],
    ],
    [
      "chat-composer-area",
      [
        "shrink-0",
        "[@media(max-width:760px)]:sticky",
        "[@media(max-width:760px)]:bottom-0",
        "[@media(max-width:760px)]:pb-[max(16px,env(safe-area-inset-bottom))]",
      ],
    ],
    ["chat-recovery", ["flex", "flex-wrap", "empty:hidden"]],
    ["chat-history", ["absolute", "inset-[100%_16px_auto]"]],
    ["max-h-[min(40dvh,320px)]", ["overflow-auto", "list-none"]],
  ] as const) {
    const classes = chatClasses(marker);
    for (const value of expected) assert.ok(classes.has(value), `${marker}: ${value}`);
    assert.ok(![...classes].some((value) => value.startsWith("md:")));
  }
});

test("answer formatting escapes raw HTML/URLs and renders text, code, headings and lists without scripts", () => {
  const markup = renderToStaticMarkup(
    <MessageContent
      content={
        "# Heading\n\nText `code` <script>alert(1)</script>\n- One\n- Two\n```html\n<img src=x onerror=alert(1)>\n```\n[unsafe](javascript:alert(1))"
      }
    />,
  );
  assert.match(markup, /class="chat-prose text-\[15px\] leading-\[1\.7\]"/);
  assert.match(markup, /<h3>Heading<\/h3>/);
  assert.match(markup, /<ul><li>One<\/li><li>Two<\/li><\/ul>/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&lt;img/);
  assert.doesNotMatch(markup, /<script|<img|href=|dangerouslySetInnerHTML/);
});

const proposal: ProposalView = {
  id: "77777777-7777-4777-8777-777777777777",
  sourceMessageId: assistantId,
  conversationId,
  turnId,
  status: "proposed",
  draft: {
    projectHint: "Ambiguous name",
    title: "Original title",
    content: "  Original content\n",
    noteDate: null,
  },
  scopedProject: null,
  receipt: null,
};
function proposalFinish(value: unknown = proposal) {
  return frame("finish", {
    turnId,
    messageId: assistantId,
    status: "completed",
    persisted: true,
    proposal: value,
  });
}
function proposalView(): ChatView {
  const f = fixture();
  f.save("completed", PROPOSAL_MESSAGE);
  return {
    ...f.view(),
    messages: f
      .view()
      .messages.map((m) => ({ ...m, proposal: m.role === "assistant" ? proposal : null })),
  };
}

test("dismissal source invalidation and reopen reconciliation preserve drafts and edited proposals without writes", async () => {
  const view = proposalView();
  const f = fixture({ existing: true, initial: ok(view), read: async () => ok(view) });
  f.session.setDraft("Keep this unsent message");
  f.session.editProposal(proposal.id, { title: "Edited while reviewing" });
  f.session.invalidateSources();
  assert.equal(f.session.getSnapshot().needsReconcile, true);
  assert.equal(f.reads.length, 0);
  await f.session.reload(false, false);
  assert.equal(f.session.getSnapshot().needsReconcile, false);
  assert.equal(f.session.getSnapshot().draft, "Keep this unsent message");
  assert.equal(f.session.getSnapshot().proposalEdits[proposal.id]!.title, "Edited while reviewing");
  assert.equal(f.session.hasProposalChanges, true);
  assert.deepEqual(f.creates, []);
  assert.deepEqual(f.confirms, []);
  assert.deepEqual(f.sent, []);
});

test("navigation focuses Main Chat while preserving discoverable legacy project history and popup entry", () => {
  const shell = readFileSync(
    new URL("../../components/workspace-shell.tsx", import.meta.url),
    "utf8",
  );
  assert.match(shell, /href="\/chat"\s+title="Main Chat — search notes across your projects"/);
  assert.match(shell, /Recent Main Chat threads/);
  const layout = readFileSync(new URL("../../app/(workspace)/layout.tsx", import.meta.url), "utf8");
  assert.match(layout, /chat\.listConversations\(\{ limit: 5, projectId: null \}\)/);
  assert.match(layout, /recentConversations=\{recent\.ok \? recent\.data : \[\]\}/);
  const screen = readFileSync(new URL("./chat-screen.tsx", import.meta.url), "utf8");
  assert.match(screen, /includeProjectChats \? \{\} : \{ projectId: null \}/);
  assert.match(screen, /Include project chats/);
  assert.match(screen, /Main Chat · Search notes across your projects/);
  assert.match(screen, /<ConversationRow/); // Canonical history links are covered by the row render test.
  assert.match(screen, /No Main Chat threads yet/);
  const page = readFileSync(
    new URL("../../app/(workspace)/projects/[projectId]/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /<ProjectChatPopup project=\{\{ id: project\.id, name: project\.name \}\}/);
  assert.doesNotMatch(page, /\/chat\?projectId/);
  const chatPage = readFileSync(
    new URL("../../app/(workspace)/chat/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(chatPage, /getConversation\(\{ conversationId, latest: true, limit: 50 \}\)/);
  assert.match(chatPage, /workspace\.getProject\(\{ projectId \}\)/);
  assert.match(chatPage, /<ChatScreen project=\{\{ id: project\.id, name: project\.name \}\}/);
});

test("popup owner wiring keeps Main Chat chrome and scrolling while hiding popup conversation controls", () => {
  const screen = readFileSync(new URL("./chat-screen.tsx", import.meta.url), "utf8");
  assert.match(screen, /!compact && \(/);
  assert.match(screen, /!compact && activeSession\.current === session/);
  assert.match(
    screen,
    /if \(popupOpen === false \|\| wasDismissed\.current\) session\.invalidateSources\(\)/,
  );
  assert.match(screen, /if \(popupOpen === false\) return/);
  assert.match(screen, /compact \|\| window\.matchMedia/);
  const popup = readFileSync(new URL("./project-chat-popup.tsx", import.meta.url), "utf8");
  assert.match(popup, /<ProjectPopup key=\{project\.id\}/);
  assert.match(popup, /hidden=\{!open\} inert=\{!open\}/);
  assert.match(popup, /aria-modal="false"/);
  assert.match(popup, /listConversations\(\{ projectId: project\.id, limit: 1, offset: 0 \}\)/);
  assert.doesNotMatch(popup, /createConversation|localStorage|sessionStorage|window\.scrollTo/);
});

test("proposal finish validates source identity and exposes a preview only after matching persisted finish", async () => {
  const result = await consumeChatResponse(
    sse(start() + delta(PROPOSAL_MESSAGE) + proposalFinish()),
    attempt,
    () => {},
    new AbortController().signal,
  );
  assert.equal(result.kind, "finish");
  if (result.kind === "finish") assert.deepEqual(result.proposal, proposal);
  for (const value of [
    { ...proposal, sourceMessageId: projectId },
    { ...proposal, turnId: projectId },
    { ...proposal, conversationId: projectId },
    { ...proposal, status: "confirmed" },
    { ...proposal, draft: { ...proposal.draft, content: "bad\u0000" } },
    { ...proposal, draft: { ...proposal.draft, noteDate: "2026-02-30" } },
    { ...proposal, receipt: { noteId: projectId, projectId, href: "javascript:alert(1)" } },
  ])
    await assert.rejects(
      consumeChatResponse(
        sse(start() + delta() + proposalFinish(value)),
        attempt,
        () => {},
        new AbortController().signal,
      ),
      TransportFailure,
    );
});

test("terminal JSON replay returns its original proposal without another request or inference", async () => {
  const messages = pair("completed", PROPOSAL_MESSAGE);
  const f = fixture({
    existing: true,
    fetch: async () =>
      Response.json({
        ok: true,
        replayed: true,
        abandoned: false,
        user: messages[0],
        assistant: messages[1],
        proposal,
      }),
  });
  f.session.setDraft(attempt.content);
  await f.session.submit();
  assert.equal(f.sent.length, 1);
  assert.equal(f.session.getSnapshot().messages.at(-1)!.proposal!.id, proposal.id);
  assert.equal(f.session.getSnapshot().messages.at(-1)!.persisted, true);
  assert.equal(f.reads.length, 0);
});

test("uncertain finalization reloads the original durable draft, never automatically regenerates", async () => {
  const view = proposalView();
  const f = fixture({
    existing: true,
    fetch: async () => sse(start() + delta(PROPOSAL_MESSAGE)),
    read: async () => ok(view),
  });
  f.session.setDraft(attempt.content);
  await f.session.submit();
  assert.equal(f.sent.length, 1);
  assert.equal(f.reads.length, 1);
  const message = f.session.getSnapshot().messages.at(-1)!;
  assert.equal(message.proposal!.id, proposal.id);
  assert.equal(message.persisted, true);
  assert.equal(f.session.getSnapshot().attempt, null);
});

test("proposal edits/project choice remain local; explicit history reload restores original, no network writes", async () => {
  const view = proposalView();
  const f = fixture({ existing: true, initial: ok(view), read: async () => ok(view) });
  assert.equal(f.session.hasProposalChanges, false);
  f.session.editProposal(proposal.id, {
    title: "Edited",
    content: "Changed\n",
    projectId,
    noteDate: "2020-01-01",
  });
  assert.equal(f.session.hasProposalChanges, true);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.creates, []);
  assert.equal(
    f.session.getSnapshot().messages.at(-1)!.proposal!.draft.content,
    proposal.draft.content,
  );
  await f.session.reload();
  assert.equal(f.session.hasProposalChanges, false);
  assert.deepEqual(f.session.getSnapshot().proposalEdits, {});
  assert.equal(f.session.getSnapshot().messages.at(-1)!.proposal!.draft.noteDate, null);
  f.session.editProposal(proposal.id, { title: proposal.draft.title });
  assert.equal(f.session.hasProposalChanges, false);
  const remounted = fixture({ existing: true, initial: ok(view) });
  assert.deepEqual(remounted.session.getSnapshot().proposalEdits, {});
});

test("automatic stale-snapshot recovery and failed explicit reload preserve local edits", async () => {
  const view = proposalView();
  const f = fixture({ existing: true, initial: ok(view), read: async () => ok(view) });
  f.session.editProposal(proposal.id, { title: "Keep local title" });
  f.session.adopt(ok({ ...view, messages: [] }));
  await until(() => !f.session.busy);
  assert.equal(f.reads.length, 1);
  assert.equal(f.session.getSnapshot().proposalEdits[proposal.id]!.title, "Keep local title");
  const denied = fixture({
    existing: true,
    initial: ok(view),
    read: async () => ({
      ok: false,
      error: { code: "UNAUTHENTICATED", message: "private sentinel" },
    }),
  });
  denied.session.editProposal(proposal.id, { title: "Keep on expiry" });
  await denied.session.reload();
  assert.equal(denied.session.hasProposalChanges, true);
  assert.equal(denied.session.getSnapshot().issue, "UNAUTHENTICATED");
});

test("invalid proposal in history fails closed instead of mounting a foreign preview", () => {
  const view = proposalView();
  view.messages.at(-1)!.proposal = { ...proposal, conversationId: projectId };
  const f = fixture({ existing: true, initial: ok(view) });
  assert.equal(f.session.getSnapshot().needsReconcile, true);
  assert.deepEqual(f.session.getSnapshot().messages, []);
});

test("preview renders escaped editable fields and nullable date without implicit form submission", () => {
  let loads = 0;
  const markup = renderToStaticMarkup(
    <ProposalPreview
      proposal={{
        ...proposal,
        draft: { ...proposal.draft, title: "<script>not executable</script>" },
      }}
      loadProjects={async () => {
        loads++;
        return ok([]);
      }}
      change={() => {}}
    />,
  );
  assert.equal(loads, 0);
  assert.match(markup, /Note draft — not saved as a note/);
  assert.match(markup, /general chat/);
  assert.match(markup, /Select a project explicitly/);
  assert.match(markup, /Ambiguous name/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /type="date"/);
  assert.match(markup, /data-unsaved="false"/);
  assert.doesNotMatch(markup, /<script|type="submit"|confirmNoteProposal/);
  const edited = renderToStaticMarkup(
    <ProposalPreview
      proposal={proposal}
      edit={{ projectId, title: "", content: "", noteDate: "2026-02-30" }}
      loadProjects={async () => ok([])}
      change={() => {}}
    />,
  );
  assert.match(edited, /data-unsaved="true"/);
  assert.match(edited, /Local changes — not saved/);
  assert.match(edited, /Please enter a note title\./);
  assert.match(edited, /Please write your note before saving\./);
  assert.match(edited, /Please enter a valid date\./);
  assert.match(edited, /aria-invalid="true"/);
  assert.match(edited, /aria-describedby="proposal-[^"]+-content-error"/);
  assert.doesNotMatch(edited, /invalid Unicode|NUL|Too small|Invalid input/);
  const scoped = renderToStaticMarkup(
    <ProposalPreview
      proposal={{ ...proposal, scopedProject: { id: projectId, name: "Owned project" } }}
      loadProjects={async () => ok([])}
      change={() => {}}
    />,
  );
  assert.match(scoped, /Project: Owned project/);
  assert.doesNotMatch(scoped, /<select/);
});

const savedNoteId = "55555555-5555-4555-8555-555555555555";
const savedProposal: ProposalView = {
  ...proposal,
  status: "confirmed",
  receipt: { noteId: savedNoteId, projectId, href: `/projects/${projectId}/notes/${savedNoteId}` },
};
const savedReceipt = { proposalId: proposal.id, ...savedProposal.receipt!, replayed: false };
function savedProposalView(): ChatView {
  const view = proposalView();
  return {
    ...view,
    messages: view.messages.map((m) => ({ ...m, proposal: m.proposal ? savedProposal : null })),
  };
}

test("late confirmation acknowledgements cannot resurrect a deleted session or its receipts", async () => {
  let release!: (result: Awaited<ReturnType<NonNullable<Dependencies["confirm"]>>>) => void;
  const waiting = new Promise<Awaited<ReturnType<NonNullable<Dependencies["confirm"]>>>>(
    (resolve) => {
      release = resolve;
    },
  );
  const f = fixture({ existing: true, initial: ok(proposalView()), confirm: async () => waiting });
  f.session.editProposal(proposal.id, { projectId });
  const saving = f.session.confirmProposal(proposal.id);
  f.session.retire();
  release(ok(savedReceipt));
  await saving;
  assert.deepEqual(f.session.getSnapshot().proposalReceipts, {});
  assert.deepEqual(f.session.getSnapshot().messages, []);
  await f.session.confirmProposal(proposal.id);
  await f.session.recoverProposal(proposal.id);
  assert.equal(f.confirms.length, 1);
  assert.equal(f.recoveries.length, 0);
});

test("explicit confirmation uses canonical edited fields and synchronously blocks double clicks and edits while saving", async () => {
  let release!: (result: Awaited<ReturnType<NonNullable<Dependencies["confirm"]>>>) => void;
  const pending = new Promise<Awaited<ReturnType<NonNullable<Dependencies["confirm"]>>>>(
    (resolve) => {
      release = resolve;
    },
  );
  const f = fixture({ existing: true, initial: ok(proposalView()), confirm: async () => pending });
  await f.session.confirmProposal(proposal.id); // General hint never selects the target.
  assert.equal(f.confirms.length, 0);
  f.session.editProposal(proposal.id, {
    projectId,
    title: "  Edited title  ",
    content: "  User content\n",
    noteDate: "2024-02-29",
  });
  const saving = f.session.confirmProposal(proposal.id);
  await f.session.confirmProposal(proposal.id);
  assert.deepEqual(f.confirms, [
    {
      proposalId: proposal.id,
      projectId,
      title: "Edited title",
      content: "  User content\n",
      noteDate: "2024-02-29",
    },
  ]);
  assert.equal(f.session.getSnapshot().proposalSaves[proposal.id]!.phase, "saving");
  assert.equal(f.session.getSnapshot().proposalReceipts[proposal.id], undefined);
  f.session.editProposal(proposal.id, { content: "Must not replace submitted payload" });
  release(ok(savedReceipt));
  await saving;
  assert.equal(f.session.getSnapshot().messages.at(-1)!.proposal!.status, "confirmed");
  assert.deepEqual(f.session.getSnapshot().proposalEdits, {});
  assert.equal(f.session.hasProposalChanges, false);
  await f.session.confirmProposal(proposal.id);
  assert.equal(f.confirms.length, 1);
  assert.deepEqual(f.sent, []);
  assert.deepEqual(f.creates, []);
  assert.deepEqual(f.recoveries, []);
});

test("lost acknowledgement recovers only an authorized matching receipt, never automatically resubmits", async () => {
  const f = fixture({
    existing: true,
    initial: ok(proposalView()),
    confirm: async () => {
      throw new Error("private network sentinel");
    },
    recoverProposal: async () => ok(savedProposal),
  });
  f.session.editProposal(proposal.id, { projectId });
  await f.session.confirmProposal(proposal.id);
  assert.equal(f.confirms.length, 1);
  assert.deepEqual(f.recoveries, [{ proposalId: proposal.id }]);
  assert.equal(f.session.getSnapshot().proposalReceipts[proposal.id]!.receipt!.noteId, savedNoteId);
  assert.deepEqual(f.session.getSnapshot().proposalSaves, {});
});

test("still-proposed recovery freezes the exact submitted payload and permits only explicit same-payload retry", async () => {
  let calls = 0;
  const view = proposalView();
  const f = fixture({
    existing: true,
    initial: ok(view),
    read: async () => ok(view),
    confirm: async () => (++calls === 1 ? unavailable() : ok({ ...savedReceipt, replayed: true })),
    recoverProposal: async () => ok(proposal),
  });
  f.session.editProposal(proposal.id, { projectId, title: "  Frozen title  " });
  await f.session.confirmProposal(proposal.id);
  assert.equal(f.confirms.length, 1);
  assert.equal(f.session.getSnapshot().proposalSaves[proposal.id]!.phase, "retry");
  f.session.editProposal(proposal.id, { title: "Cannot change an unresolved write" });
  await f.session.reload(); // Does not discard the unresolved operation identity/payload.
  await f.session.confirmProposal(proposal.id);
  assert.equal(f.confirms.length, 2);
  assert.deepEqual(f.confirms[0], f.confirms[1]);
  assert.equal(f.session.getSnapshot().proposalReceipts[proposal.id]!.status, "confirmed");
});

test("off-page unresolved saves remain dirty and expose the session guard to sign-out", async () => {
  const view = proposalView();
  const latest = {
    ...view,
    messages: Array.from({ length: 25 }, () =>
      pair("completed", "Newer saved response", crypto.randomUUID()).map((message) => ({
        ...message,
        id: crypto.randomUUID(),
        proposal: null,
        sources: message.sources ?? [],
        modelId: message.role === "assistant" ? "test-model" : null,
        createdAt: now,
        updatedAt: now,
      })),
    ).flat(),
  };
  let recoveries = 0;
  const f = fixture({
    existing: true,
    initial: ok(view),
    read: async () => ok(latest),
    confirm: async () => unavailable(),
    recoverProposal: async () => (++recoveries === 1 ? unavailable() : ok(savedProposal)),
  });
  f.session.editProposal(proposal.id, { projectId });
  await f.session.confirmProposal(proposal.id);
  const payload = f.session.getSnapshot().proposalSaves[proposal.id]!.payload;
  await f.session.reload();
  assert.equal(
    f.session.getSnapshot().messages.some((message) => message.proposal),
    false,
  );
  assert.deepEqual(f.session.getSnapshot().proposalEdits, {});
  assert.deepEqual(f.session.getSnapshot().proposalSaves[proposal.id]!.payload, payload);
  assert.equal(f.session.hasProposalChanges, true);
  assert.equal(f.confirms.length, 1);

  // SignOutButton scans forms, including when the individual draft is off-page.
  // Check the owner wiring as well as the state; mounted-browser acceptance
  // separately exercises the real click guard with mocked auth/actions.
  const source = readFileSync(new URL("./chat-screen.tsx", import.meta.url), "utf8");
  const composer = source.match(/<form\s+ref=\{form\}[\s\S]*?onSubmit=/)?.[0];
  assert.ok(composer);
  assert.match(composer, /data-unsaved=\{dirty \? "true" : "false"\}/);
  assert.match(
    source,
    /const dirty = session\.hasProposalChanges \|\| \(compact && !!state\.draft\)/,
  );

  await f.session.recoverProposal(proposal.id);
  assert.equal(f.session.hasProposalChanges, false);
  assert.equal(f.confirms.length, 1);
});

test("failed recovery retains Save unconfirmed, blocks writes and allows another explicit read", async () => {
  let reads = 0;
  const f = fixture({
    existing: true,
    initial: ok(proposalView()),
    confirm: async () => unavailable(),
    recoverProposal: async () => (++reads === 1 ? unavailable() : ok(savedProposal)),
  });
  f.session.editProposal(proposal.id, { projectId });
  await f.session.confirmProposal(proposal.id);
  assert.equal(f.session.getSnapshot().proposalSaves[proposal.id]!.phase, "uncertain");
  assert.equal(f.session.hasProposalChanges, true);
  await f.session.confirmProposal(proposal.id);
  assert.equal(f.confirms.length, 1);
  await f.session.recoverProposal(proposal.id);
  assert.equal(f.recoveries.length, 2);
  assert.equal(f.session.getSnapshot().proposalReceipts[proposal.id]!.status, "confirmed");
});

for (const code of ["UNAUTHENTICATED", "NOT_FOUND", "CONFLICT", "INVALID_INPUT"] as const)
  test(`definite confirmation ${code} never fabricates success or automatically retries`, async () => {
    const f = fixture({
      existing: true,
      initial: ok(proposalView()),
      confirm: async () => ({ ok: false, error: { code, message: "private sentinel" } }),
    });
    f.session.editProposal(proposal.id, { projectId });
    await f.session.confirmProposal(proposal.id);
    assert.equal(f.session.getSnapshot().proposalSaves[proposal.id]!.issue, code);
    assert.equal(f.session.getSnapshot().proposalReceipts[proposal.id], undefined);
    assert.deepEqual(f.recoveries, []);
    assert.equal(f.confirms.length, 1);
  });

test("a session-denied retry cannot unlock the payload of an earlier uncertain save", async () => {
  let writes = 0,
    reads = 0;
  const f = fixture({
    existing: true,
    initial: ok(proposalView()),
    confirm: async () =>
      ++writes === 1
        ? unavailable()
        : { ok: false, error: { code: "UNAUTHENTICATED", message: "safe" } },
    recoverProposal: async () =>
      ++reads === 1
        ? ok(proposal)
        : { ok: false, error: { code: "UNAUTHENTICATED", message: "safe" } },
  });
  f.session.editProposal(proposal.id, { projectId, title: "Frozen" });
  await f.session.confirmProposal(proposal.id);
  await f.session.confirmProposal(proposal.id);
  assert.equal(f.session.getSnapshot().proposalSaves[proposal.id]!.phase, "uncertain");
  f.session.editProposal(proposal.id, { title: "Must not change" });
  assert.equal(f.session.getSnapshot().proposalSaves[proposal.id]!.payload.title, "Frozen");
  await f.session.confirmProposal(proposal.id);
  assert.equal(f.confirms.length, 2);
});

test("malformed save acknowledgement and foreign-source recovery remain unconfirmed", async () => {
  const f = fixture({
    existing: true,
    initial: ok(proposalView()),
    confirm: async () => ok({ ...savedReceipt, href: "javascript:alert(1)" }),
    recoverProposal: async () => ok({ ...savedProposal, sourceMessageId: projectId }),
  });
  f.session.editProposal(proposal.id, { projectId });
  await f.session.confirmProposal(proposal.id);
  assert.equal(f.session.getSnapshot().proposalReceipts[proposal.id], undefined);
  assert.equal(f.session.getSnapshot().proposalSaves[proposal.id]!.phase, "uncertain");
  assert.equal(f.confirms.length, 1);
});

test("newly confirmed receipts survive stale history/RSC responses and late proposed recovery", async () => {
  let release!: (result: Awaited<ReturnType<NonNullable<Dependencies["recoverProposal"]>>>) => void;
  const pending = new Promise<Awaited<ReturnType<NonNullable<Dependencies["recoverProposal"]>>>>(
    (resolve) => {
      release = resolve;
    },
  );
  const f = fixture({
    existing: true,
    initial: ok(proposalView()),
    read: async () => ok(proposalView()),
    confirm: async () => unavailable(),
    recoverProposal: async () => pending,
  });
  f.session.editProposal(proposal.id, { projectId });
  const saving = f.session.confirmProposal(proposal.id);
  await until(() => f.session.getSnapshot().proposalSaves[proposal.id]?.phase === "checking");
  f.session.adopt(ok(savedProposalView()));
  await until(() => !!f.session.getSnapshot().proposalReceipts[proposal.id]);
  release(ok(proposal));
  await saving;
  f.session.adopt(ok(proposalView()));
  await f.session.reload();
  assert.equal(f.session.getSnapshot().messages.at(-1)!.proposal!.status, "confirmed");
  assert.deepEqual(f.session.getSnapshot().proposalSaves, {});
  const remounted = fixture({ existing: true, initial: ok(savedProposalView()) });
  assert.equal(
    remounted.session.getSnapshot().messages.at(-1)!.proposal!.receipt!.noteId,
    savedNoteId,
  );
});

test("confirmation markup shows explicit valid Save, disabled saving, uncertainty/recovery and verified receipt only", () => {
  const edited = { projectId, title: "Ready", content: "Content", noteDate: "" };
  const render = (props: Partial<Parameters<typeof ProposalPreview>[0]> = {}) =>
    renderToStaticMarkup(
      <ProposalPreview
        proposal={proposal}
        edit={edited}
        change={() => {}}
        loadProjects={async () => ok([])}
        save={() => {}}
        recover={() => {}}
        {...props}
      />,
    );
  const ready = render();
  assert.match(ready, />Save note</);
  assert.doesNotMatch(ready, /Note saved\./);
  const payload = {
    proposalId: proposal.id,
    projectId,
    title: "Ready",
    content: "Content",
    noteDate: null,
  };
  const saving = render({ saveState: { phase: "saving", proposal, payload, issue: null } });
  assert.match(saving, /Saving note/);
  assert.match(saving, /disabled=""/);
  assert.doesNotMatch(saving, /Open saved note/);
  const uncertain = render({
    saveState: { phase: "uncertain", proposal, payload, issue: "UNAVAILABLE" },
  });
  assert.match(uncertain, /Save unconfirmed/);
  assert.match(uncertain, /Check saved status/);
  assert.doesNotMatch(uncertain, />Save note<|Note saved\.|No note has been created/);
  const confirmed = render({ proposal: savedProposal });
  assert.match(confirmed, /Note saved\./);
  assert.match(confirmed, /Open saved note/);
  assert.match(confirmed, new RegExp(`/projects/${projectId}/notes/${savedNoteId}`));
  assert.doesNotMatch(confirmed, /<button|<form/);
});
