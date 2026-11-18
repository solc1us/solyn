import assert from "node:assert/strict";
import { test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import {
  ChatSession,
  ChatSessions,
  conversationTitle,
  messageStatus,
  shouldSend,
  type ChatView,
} from "./client-state";
import { MessageContent } from "./message-content";
import {
  consumeChatResponse,
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
  } = {},
) {
  const sent: Attempt[] = [];
  const creates: unknown[] = [];
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

test("answer formatting escapes raw HTML/URLs and renders text, code, headings and lists without scripts", () => {
  const markup = renderToStaticMarkup(
    <MessageContent
      content={
        "# Heading\n\nText `code` <script>alert(1)</script>\n- One\n- Two\n```html\n<img src=x onerror=alert(1)>\n```\n[unsafe](javascript:alert(1))"
      }
    />,
  );
  assert.match(markup, /<h3>Heading<\/h3>/);
  assert.match(markup, /<ul><li>One<\/li><li>Two<\/li><\/ul>/);
  assert.match(markup, /&lt;script&gt;/);
  assert.match(markup, /&lt;img/);
  assert.doesNotMatch(markup, /<script|<img|href=|dangerouslySetInnerHTML/);
});
