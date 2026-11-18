import assert from "node:assert/strict";
import { test } from "node:test";

import { createGroq } from "@ai-sdk/groq";
import { APICallError, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import type { ErrorCode } from "./contracts";
import {
  CHAT_MODEL_ID,
  createChatStreamHandler,
  MAX_OUTPUT_TOKENS,
  PROVIDER_TIMEOUT_MS,
} from "./stream-handler";
import { PENDING_TIMEOUT_MS } from "./service";

type Dependencies = Parameters<typeof createChatStreamHandler>[0];
type Chat = Dependencies["chat"];
const conversationId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const otherTurn = "33333333-3333-4333-8333-333333333333";
const now = new Date("2026-01-01T00:00:00Z");
const turn = { conversationId, turnId };
const payload = { ...turn, content: "  Current message\n" };
const origin = "https://solyn.example";
const fakeKey = "synthetic-not-a-real-key";
const user = {
  id: "user-message",
  ...turn,
  role: "user",
  content: payload.content,
  status: "completed",
  modelId: null,
  createdAt: now,
  updatedAt: now,
} as const;
const assistant = {
  ...user,
  id: "assistant-message",
  role: "assistant",
  content: "",
  status: "pending",
  modelId: CHAT_MODEL_ID,
} as const;
const conversation = {
  id: conversationId,
  projectId: null,
  title: "Chat",
  createdAt: now,
  updatedAt: now,
};
const ok = <T>(data: T) => ({ ok: true as const, data });
const denied = (code: ErrorCode = "UNAVAILABLE") => ({
  ok: false as const,
  error: { code, message: "internal safe error" },
});
const finish = (reason: "stop" | "length" = "stop") => ({
  type: "finish" as const,
  finishReason: { unified: reason, raw: undefined },
  usage: {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  },
});
function model(text = "Persisted answer", reason: "stop" | "length" = "stop") {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: text },
          { type: "text-end", id: "text" },
          finish(reason),
        ],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
}
function stalledModel() {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-start", id: "text" });
          controller.enqueue({ type: "text-delta", id: "text", delta: "Partial answer" });
          // Deliberately never closes, and ignores the provider abort signal.
        },
      }),
    }),
  });
}
function request(
  body: unknown = payload,
  headers: Record<string, string | undefined> = {},
  signal?: AbortSignal,
) {
  return new Request(`${origin}/api/chat/stream`, {
    method: "POST",
    signal,
    headers: {
      origin,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...Object.fromEntries(
        Object.entries(headers).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function events(text: string) {
  return text
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const [event, data] = frame.split("\n");
      return { event: event!.slice(7), data: JSON.parse(data!.slice(6)) };
    });
}
function fixture(
  options: {
    model?: MockLanguageModelV4;
    chat?: Partial<Chat>;
    session?: boolean;
    apiKey?: string;
    timeoutMs?: number;
    provider?: Dependencies["model"];
  } = {},
) {
  const calls: { operation: string; input: unknown }[] = [];
  const provider = options.model ?? model();
  let modelCalls = 0;
  let sessionCalls = 0;
  const chat: Chat = {
    beginTurn: async (input) => {
      calls.push({ operation: "begin", input });
      return ok({ user, assistant, replayed: false, abandoned: false });
    },
    getGenerationContext: async (input) => {
      calls.push({ operation: "context", input });
      return ok({ conversation, project: null, turns: [] });
    },
    completeResponse: async (input) => {
      calls.push({ operation: "complete", input });
      return ok({
        ...assistant,
        status: "completed",
        content: (input as { content: string }).content,
      });
    },
    failResponse: async (input) => {
      calls.push({ operation: "fail", input });
      return ok({
        ...assistant,
        status: "failed",
        content: (input as { content?: string }).content ?? "",
      });
    },
    stopResponse: async (input) => {
      calls.push({ operation: "stop", input });
      return ok({
        ...assistant,
        status: "stopped",
        content: (input as { content?: string }).content ?? "",
      });
    },
    ...options.chat,
  };
  const post = createChatStreamHandler({
    chat,
    origin,
    timeoutMs: options.timeoutMs,
    getSession: async () => {
      sessionCalls++;
      return options.session === false ? null : { user: { id: "owner-from-session" } };
    },
    getApiKey: () => options.apiKey ?? fakeKey,
    model: (key) => {
      modelCalls++;
      assert.equal(key, fakeKey);
      return options.provider ? options.provider(key) : provider;
    },
  });
  return { post, calls, provider, modelCalls: () => modelCalls, sessionCalls: () => sessionCalls };
}

test("stream denies anonymous, cross-origin, missing origin and cross-site requests before writes/provider", async () => {
  const anonymous = fixture({ session: false });
  assert.equal((await anonymous.post(request())).status, 401);
  assert.deepEqual(anonymous.calls, []);
  for (const headers of [
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: "" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ]) {
    const f = fixture();
    assert.equal((await f.post(request(payload, headers))).status, 403);
    assert.equal(f.sessionCalls(), 0);
    assert.equal(f.modelCalls(), 0);
    assert.deepEqual(f.calls, []);
  }
  const noOrigin = request();
  noOrigin.headers.delete("origin");
  assert.equal((await fixture().post(noOrigin)).status, 403);
});

test("stream validates strict JSON shape, IDs, text, type and actual byte limit before writes", async () => {
  for (const body of [
    { ...payload, ownerId: "other-owner" },
    { ...payload, modelId: "unapproved" },
    { ...payload, projectId: otherTurn },
    { ...payload, assistant: "forged" },
    { ...payload, content: " " },
    { ...payload, content: "x".repeat(4001) },
    { ...payload, content: "\ud800" },
    { ...payload, content: "\u0000" },
    { ...payload, content: 1 },
    { ...payload, turnId: "invalid" },
    { ...payload, conversationId: "invalid" },
    {},
    null,
    [],
    "not JSON",
  ]) {
    const f = fixture();
    assert.equal((await f.post(request(body))).status, 400);
    assert.deepEqual(f.calls, []);
    assert.equal(f.modelCalls(), 0);
  }
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/jsonish"]) {
    const f = fixture();
    assert.equal((await f.post(request(payload, { "content-type": type }))).status, 415);
    assert.deepEqual(f.calls, []);
  }
  for (const headers of [{ "content-length": "999999" }, { "content-length": "1" }, {}]) {
    const f = fixture();
    const response = await f.post(request({ ...payload, content: "💙".repeat(9000) }, headers));
    assert.equal(response.status, 413);
    assert.deepEqual(f.calls, []);
  }
});

test("ownership denial and ambiguous begin never invoke provider or terminal writes", async () => {
  for (const code of ["NOT_FOUND", "CONFLICT", "UNAVAILABLE"] as const) {
    let begins = 0;
    const f = fixture({
      chat: {
        beginTurn: async () => {
          begins++;
          return denied(code);
        },
      },
    });
    const response = await f.post(request());
    assert.equal(response.status, code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 503);
    assert.equal(begins, 1);
    assert.equal(f.modelCalls(), 0);
    assert.deepEqual(f.calls, []);
  }
});

test("successful stream uses fixed model, exact persisted input and confirms full save before finish", async () => {
  const f = fixture();
  const response = await f.post(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  const parts = events(await response.text());
  assert.deepEqual(
    parts.map((p) => p.event),
    ["start", "text-delta", "finish"],
  );
  assert.deepEqual(
    f.calls.map((c) => c.operation),
    ["begin", "context", "complete"],
  );
  assert.deepEqual(f.calls[0]!.input, { ...payload, modelId: CHAT_MODEL_ID });
  assert.deepEqual(f.calls[2]!.input, { ...turn, content: "Persisted answer" });
  assert.equal(parts.at(-1)!.data.persisted, true);
  assert.equal(f.provider.doStreamCalls.length, 1);
  const call = f.provider.doStreamCalls[0]!;
  assert.equal(call.maxOutputTokens, MAX_OUTPUT_TOKENS);
  assert.deepEqual(call.providerOptions, {
    groq: { reasoningFormat: "parsed", reasoningEffort: "low" },
  });
  assert.equal(call.prompt.filter((m) => m.role === "user").length, 1);
  assert.deepEqual(call.prompt.at(-1), {
    role: "user",
    content: [{ type: "text", text: user.content }],
    providerOptions: undefined,
  });
  assert.ok(!call.tools?.length);
  assert.ok(PROVIDER_TIMEOUT_MS < PENDING_TIMEOUT_MS);
});

test("finish acknowledgement waits for completion persistence", async () => {
  let entered!: () => void;
  const saving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const saved = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture({
    chat: {
      completeResponse: async () => {
        entered();
        await saved;
        return ok({ ...assistant, status: "completed" });
      },
    },
  });
  const response = await f.post(request());
  let resolved = false;
  const text = response.text().then((value) => {
    resolved = true;
    return value;
  });
  await saving;
  await Promise.resolve();
  assert.equal(resolved, false);
  release();
  assert.equal(events(await text).at(-1)!.event, "finish");
});

test("scoped prompt uses bounded owned metadata and latest completed history once, chronologically", async () => {
  const turns = Array.from({ length: 8 }, (_, i) => ({
    user: `question-${i}:` + "q".repeat(1990),
    assistant: `answer-${i}:` + "a".repeat(1990),
  }));
  const f = fixture({
    chat: {
      getGenerationContext: async () =>
        ok({
          conversation,
          project: { name: "Owned project", description: "Authorized description" },
          turns,
        }),
    },
  });
  await (await f.post(request())).text();
  const prompt = JSON.stringify(f.provider.doStreamCalls[0]!.prompt);
  assert.match(prompt, /Owned project/);
  assert.match(prompt, /Authorized description/);
  assert.match(prompt, /question-7/);
  assert.doesNotMatch(prompt, /question-6|question-0/);
  assert.equal(prompt.split("Current message").length - 1, 1);
  assert.ok(prompt.indexOf("question-7") < prompt.indexOf("answer-7"));
  assert.ok(prompt.indexOf("answer-7") < prompt.indexOf("Current message"));
  const chronological = fixture({
    chat: {
      getGenerationContext: async () =>
        ok({
          conversation,
          project: null,
          turns: [
            { user: "first-question", assistant: "first-answer" },
            { user: "second-question", assistant: "second-answer" },
          ],
        }),
    },
  });
  await (await chronological.post(request())).text();
  const contents = JSON.stringify(chronological.provider.doStreamCalls[0]!.prompt);
  assert.ok(contents.indexOf("first-question") < contents.indexOf("second-question"));
  assert.ok(contents.indexOf("second-answer") < contents.indexOf("Current message"));
  assert.doesNotMatch(contents, /Project metadata/);
});

test("pending, abandoned and terminal replays return persisted records without context/provider calls", async () => {
  for (const status of ["pending", "completed", "failed", "stopped"] as const) {
    for (const abandoned of [false, true]) {
      const f = fixture({
        chat: {
          beginTurn: async () =>
            ok({ user, assistant: { ...assistant, status }, replayed: true, abandoned }),
        },
      });
      const response = await f.post(request());
      assert.match(response.headers.get("content-type")!, /^application\/json(?:;|$)/);
      const json = await response.json();
      assert.equal(json.replayed, true);
      assert.equal(json.assistant.status, status);
      assert.equal(json.abandoned, abandoned);
      assert.deepEqual(f.calls, []);
      assert.equal(f.modelCalls(), 0);
    }
  }
});

test("concurrent HTTP same-ID replay and different-ID conflict start at most one provider", async () => {
  for (const sameId of [true, false]) {
    let active: string | null = null;
    const f = fixture({
      chat: {
        beginTurn: async (input) => {
          const value = input as typeof payload;
          if (active && value.turnId !== active) return denied("CONFLICT");
          const replayed = active !== null;
          active = value.turnId;
          return ok({ user, assistant, replayed, abandoned: false });
        },
      },
    });
    const responses = await Promise.all([
      f.post(request()),
      f.post(request({ ...payload, turnId: sameId ? turnId : otherTurn })),
    ]);
    await Promise.all(responses.map((r) => r.text()));
    assert.equal(f.modelCalls(), 1);
    assert.equal(f.provider.doStreamCalls.length, 1);
    assert.equal(responses[1]!.status, sameId ? 200 : 409);
  }
});

test("context failure safely fails the newly persisted turn without inference", async () => {
  const f = fixture({ chat: { getGenerationContext: async () => denied() } });
  assert.equal((await f.post(request())).status, 503);
  assert.deepEqual(
    f.calls.map((c) => c.operation),
    ["begin", "fail"],
  );
  assert.equal(f.modelCalls(), 0);
  const unconfirmed = fixture({
    chat: { getGenerationContext: async () => denied(), failResponse: async () => denied() },
  });
  assert.equal((await (await unconfirmed.post(request())).json()).error.code, "PERSISTENCE_FAILED");
});

test("missing key refuses before begin; provider errors expose only safe categories and never retry", async () => {
  const missing = fixture({ apiKey: " " });
  assert.equal((await (await missing.post(request())).json()).error.code, "PROVIDER_CONFIGURATION");
  assert.deepEqual(missing.calls, []);
  for (const [statusCode, code] of [
    [401, "PROVIDER_AUTH"],
    [403, "PROVIDER_AUTH"],
    [429, "RATE_LIMITED"],
    [400, "PROVIDER_REJECTED"],
    [500, "PROVIDER_NETWORK"],
    [504, "PROVIDER_TIMEOUT"],
  ] as const) {
    const provider = new MockLanguageModelV4({
      doStream: async () => {
        throw new APICallError({
          message: "private-key-SENTINEL private-message-SENTINEL",
          url: "https://unused.invalid",
          requestBodyValues: { secret: "private-key-SENTINEL" },
          statusCode,
        });
      },
    });
    const f = fixture({ model: provider });
    const text = await (await f.post(request())).text();
    assert.equal(events(text).at(-1)!.data.code, code);
    assert.doesNotMatch(text, /SENTINEL|requestBodyValues|stack/);
    assert.equal(provider.doStreamCalls.length, 1);
    assert.deepEqual(
      f.calls.map((c) => c.operation),
      ["begin", "context", "fail"],
    );
  }
  const network = fixture({
    model: new MockLanguageModelV4({
      doStream: async () => {
        throw new TypeError("private-network-SENTINEL");
      },
    }),
  });
  const text = await (await network.post(request())).text();
  assert.match(text, /PROVIDER_NETWORK/);
  assert.doesNotMatch(text, /SENTINEL/);
});

test("midstream error preserves only visible partial text, hides reasoning/errors and does not retry", async () => {
  const provider = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "reasoning-start", id: "reasoning" },
          { type: "reasoning-delta", id: "reasoning", delta: "private-reasoning-SENTINEL" },
          { type: "reasoning-end", id: "reasoning" },
          { type: "text-start", id: "text" },
          { type: "text-delta", id: "text", delta: "Visible partial" },
          {
            type: "error",
            error: new APICallError({
              message: "private-provider-SENTINEL",
              url: "https://unused.invalid",
              requestBodyValues: {},
              statusCode: 429,
            }),
          },
        ],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
  const f = fixture({ model: provider });
  const text = await (await f.post(request())).text();
  assert.equal(events(text).at(-1)!.data.code, "RATE_LIMITED");
  assert.doesNotMatch(text, /SENTINEL/);
  assert.deepEqual(f.calls.at(-1), {
    operation: "fail",
    input: { ...turn, content: "Visible partial" },
  });
  assert.equal(provider.doStreamCalls.length, 1);
});

test("empty, unrepresentable and output-limited answers are failed, never reported as completed", async () => {
  for (const [provider, code] of [
    [model("  "), "EMPTY_RESPONSE"],
    [model("\u0000"), "PROVIDER_REJECTED"],
    [model("\ud800"), "PROVIDER_REJECTED"],
    [model("partial", "length"), "OUTPUT_LIMIT"],
    [model("x".repeat(20_001)), "OUTPUT_LIMIT"],
  ] as const) {
    const f = fixture({ model: provider });
    const parts = events(await (await f.post(request())).text());
    assert.equal(parts.at(-1)!.data.code, code);
    assert.equal(parts.at(-1)!.data.status, "failed");
    assert.ok(!parts.some((p) => p.event === "finish"));
    assert.equal(f.calls.at(-1)!.operation, "fail");
  }
});

test("provider timeout bounds a stalled stream and saves safe partial output as failed", async () => {
  const f = fixture({ model: stalledModel(), timeoutMs: 25 });
  const parts = events(await (await f.post(request())).text());
  assert.equal(parts.at(-1)!.data.code, "PROVIDER_TIMEOUT");
  assert.deepEqual(f.calls.at(-1), {
    operation: "fail",
    input: { ...turn, content: "Partial answer" },
  });
  assert.equal(f.provider.doStreamCalls.length, 1);
});

test("response cancellation aborts provider and persists stopped partial exactly once", async () => {
  const f = fixture({ model: stalledModel() });
  const response = await f.post(request());
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const part = await reader.read();
    if (decoder.decode(part.value).includes("text-delta")) break;
  }
  await reader.cancel();
  assert.deepEqual(f.calls.at(-1), {
    operation: "stop",
    input: { ...turn, content: "Partial answer" },
  });
  assert.equal(f.calls.filter((c) => ["complete", "stop", "fail"].includes(c.operation)).length, 1);
  assert.equal(f.provider.doStreamCalls[0]!.abortSignal!.aborted, true);
});

test("request abort during inference stops; abort during confirmed begin never calls provider", async () => {
  const controller = new AbortController();
  const f = fixture({ model: stalledModel() });
  const response = await f.post(request(payload, {}, controller.signal));
  const reader = response.body!.getReader();
  while (true) {
    const part = await reader.read();
    if (new TextDecoder().decode(part.value).includes("text-delta")) break;
  }
  controller.abort();
  while (!(await reader.read()).done) {
    /* Drain the closed transport. */
  }
  assert.equal(f.calls.at(-1)!.operation, "stop");
  const earlyController = new AbortController();
  const early = fixture({
    chat: {
      beginTurn: async () => {
        earlyController.abort();
        return ok({ user, assistant, replayed: false, abandoned: false });
      },
    },
  });
  assert.equal((await early.post(request(payload, {}, earlyController.signal))).status, 499);
  assert.equal(early.modelCalls(), 0);
  assert.equal(early.calls.at(-1)!.operation, "stop");
});

test("disconnect during completion does not race a second terminal write against the commit", async () => {
  let entered!: () => void;
  const saving = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const saved = new Promise<void>((resolve) => {
    release = resolve;
  });
  let completions = 0;
  const controller = new AbortController();
  const f = fixture({
    chat: {
      completeResponse: async () => {
        completions++;
        entered();
        await saved;
        return ok({ ...assistant, status: "completed" });
      },
    },
  });
  const response = await f.post(request(payload, {}, controller.signal));
  const text = response.text();
  await saving;
  controller.abort();
  release();
  assert.ok(!events(await text).some((part) => part.event === "finish"));
  assert.equal(completions, 1);
  assert.ok(!f.calls.some((c) => c.operation === "stop" || c.operation === "fail"));
});

test("ambiguous/conflicting completion never reports success, retries inference or overwrites terminal state", async () => {
  for (const throws of [false, true]) {
    let completions = 0;
    const f = fixture({
      chat: {
        completeResponse: async () => {
          completions++;
          if (throws) throw new Error("private-SENTINEL");
          return denied("CONFLICT");
        },
      },
    });
    const text = await (await f.post(request())).text();
    const parts = events(text);
    assert.equal(parts.at(-1)!.data.code, "PERSISTENCE_FAILED");
    assert.equal(parts.at(-1)!.data.persistence, "unconfirmed");
    assert.ok(!parts.some((p) => p.event === "finish"));
    assert.doesNotMatch(text, /SENTINEL|persisted/);
    assert.equal(completions, 1);
    assert.equal(f.provider.doStreamCalls.length, 1);
    assert.ok(!f.calls.some((c) => c.operation === "fail" || c.operation === "stop"));
  }
  const unconfirmed = fixture({ model: model(""), chat: { failResponse: async () => denied() } });
  assert.equal(
    events(await (await unconfirmed.post(request())).text()).at(-1)!.data.code,
    "PERSISTENCE_FAILED",
  );
});

test("real Groq adapter uses only approved model/options and performs one mocked HTTP inference", async () => {
  let fetches = 0;
  const f = fixture({
    provider: (apiKey) =>
      createGroq({
        apiKey,
        fetch: async (url, init) => {
          fetches++;
          assert.equal(String(url), "https://api.groq.com/openai/v1/chat/completions");
          const body = JSON.parse(init!.body as string);
          assert.equal(body.model, CHAT_MODEL_ID);
          assert.equal(body.max_tokens ?? body.max_completion_tokens, MAX_OUTPUT_TOKENS);
          assert.equal(body.stream, true);
          assert.equal(body.reasoning_format, "parsed");
          assert.equal(body.reasoning_effort, "low");
          assert.ok(!body.tools?.length);
          // A real SDK API-error path, not an injected high-level service result.
          return Response.json(
            { error: { message: "private-key-SENTINEL", type: "rate_limit_error" } },
            { status: 429 },
          );
        },
      })(CHAT_MODEL_ID),
  });
  const text = await (await f.post(request())).text();
  assert.equal(fetches, 1);
  assert.match(text, /RATE_LIMITED/);
  assert.doesNotMatch(text, /SENTINEL|synthetic-not-a-real-key/);
});
