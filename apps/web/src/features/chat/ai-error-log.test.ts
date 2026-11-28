import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { APICallError, StreamProviderError } from "ai";
import { z } from "zod";
import {
  AI_LOG_MAX_BYTES,
  aiErrorLogPath,
  createAIErrorLogger,
  safeAIDiagnostic,
  type AIErrorContext,
} from "./ai-error-log";

const context: AIErrorContext = {
  code: "PROVIDER_REJECTED",
  step: 2,
  tool: "prepareTaskUpdate",
  stage: "generation",
  durationMs: 123.4,
  persistence: "confirmed",
};
const secret = "PRIVATE_USER_NOTE_TASK_KEY_PASSWORD_SESSION";
function apiError(message: string, statusCode = 400, requestId = "req_0123456789abcdef") {
  return new APICallError({
    message,
    url: `https://private.example/${secret}`,
    requestBodyValues: { messages: secret },
    statusCode,
    responseHeaders: { "x-request-id": requestId, authorization: secret, "set-cookie": secret },
    responseBody: JSON.stringify({ failed_generation: secret }),
    data: { error: { message: secret } },
    cause: new Error(secret),
  });
}
function temporaryWeb() {
  const root = mkdtempSync(join(tmpdir(), "solyn-ai-log-"));
  const web = join(root, "apps", "web");
  mkdirSync(join(web, "src/features/chat"), { recursive: true });
  writeFileSync(join(web, "package.json"), "{}");
  writeFileSync(join(web, "src/features/chat/stream-handler.ts"), "");
  return {
    root,
    web,
    path: join(web, "logs", "ai-error-log.txt"),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("diagnostics allowlist SDK metadata and schema field names, never raw errors, bodies, arguments, causes or stacks", () => {
  const diagnostic = safeAIDiagnostic(
    context,
    apiError(
      `invalid JSON schema for tool prepareTaskUpdate, /properties/changes/required. Missing required properties: assignee, description, dueDate, priority, status, title. ${secret}`,
    ),
  );
  assert.equal(diagnostic.category, "provider_schema_rejection");
  assert.equal(diagnostic.httpStatus, 400);
  assert.equal(diagnostic.requestId, "req_0123456789abcdef");
  assert.equal(diagnostic.durationMs, 123);
  assert.equal(diagnostic.tool, "prepareTaskUpdate");
  assert.deepEqual(diagnostic.schemaFields, [
    "changes",
    "title",
    "status",
    "priority",
    "description",
    "assignee",
    "dueDate",
  ]);
  assert.match(diagnostic.timestamp, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.doesNotMatch(
    JSON.stringify(diagnostic),
    new RegExp(
      secret +
        "|authorization|set-cookie|private.example|failed_generation|stack|cause|requestBody|responseBody",
    ),
  );
  const args = safeAIDiagnostic(
    context,
    apiError(
      `Tool call validation failed: parameters for tool searchTasks did not match schema. Missing properties: title, priority, dueDateFrom, dueDateTo, overdueBefore. ${secret}`,
    ),
  );
  assert.equal(args.category, "generated_argument_validation");
  assert.equal(args.tool, "searchTasks");
  assert.deepEqual(args.schemaFields, [
    "title",
    "priority",
    "dueDateFrom",
    "dueDateTo",
    "overdueBefore",
  ]);
  assert.equal(
    safeAIDiagnostic(context, apiError(secret, 401)).category,
    "provider_request_rejection",
  );
  assert.equal(
    safeAIDiagnostic({ ...context, code: "PROVIDER_TIMEOUT" }, apiError(secret, 408)).category,
    "timeout",
  );
  const stream = safeAIDiagnostic(
    context,
    new StreamProviderError({
      message: secret,
      statusCode: 429,
      code: secret,
      data: { failed_generation: secret },
      cause: new Error(secret),
    }),
  );
  assert.equal(stream.httpStatus, 429);
  assert.doesNotMatch(JSON.stringify(stream), new RegExp(secret));
});

test("diagnostics reject arbitrary context values and request IDs; inspect only known Zod field names, not input values", () => {
  const bad = {
    ...context,
    code: secret,
    tool: secret,
    category: secret,
    stage: secret,
    persistence: secret,
    step: 999,
    durationMs: Infinity,
  } as unknown as AIErrorContext;
  const diagnostic = safeAIDiagnostic(bad, apiError(secret, 400, "gsk_secret-session-token"));
  assert.doesNotMatch(JSON.stringify(diagnostic), new RegExp(secret + "|gsk_secret"));
  assert.equal(diagnostic.requestId, undefined);
  assert.equal(diagnostic.step, undefined);
  assert.equal(diagnostic.durationMs, 0);
  const result = z.strictObject({ title: z.string() }).safeParse({ title: 42 });
  assert.equal(result.success, false);
  if (!result.success)
    assert.deepEqual(
      safeAIDiagnostic({ ...context, category: "generated_argument_validation" }, result.error)
        .schemaFields,
      ["title"],
    );
  assert.doesNotMatch(
    JSON.stringify(safeAIDiagnostic(context, new Error(secret))),
    new RegExp(secret),
  );
});

test("local logging resolves actual root/web working directories and appends JSONL with directory creation", () => {
  const actualRoot = resolve(import.meta.dirname, "../../../../..");
  assert.equal(aiErrorLogPath(actualRoot), join(actualRoot, "apps/web/logs/ai-error-log.txt"));
  assert.equal(
    aiErrorLogPath(join(actualRoot, "apps/web")),
    join(actualRoot, "apps/web/logs/ai-error-log.txt"),
  );
  const f = temporaryWeb();
  try {
    const logger = createAIErrorLogger({ cwd: () => f.root, production: () => false });
    logger(context, apiError(secret));
    const loggerFromWeb = createAIErrorLogger({ cwd: () => f.web, production: () => false });
    loggerFromWeb(
      { ...context, stage: "finalization", code: "PERSISTENCE_FAILED", persistence: "unconfirmed" },
      new Error(secret),
    );
    const lines = readFileSync(f.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[1].category, "persistence_failure");
    assert.equal(lines[1].stage, "finalization");
    assert.doesNotMatch(readFileSync(f.path, "utf8"), new RegExp(secret));
    assert.ok(statSync(f.path).size < 2048);
  } finally {
    f.close();
  }
});

test("local retention caps the current file at 1 MiB plus one bounded previous file", () => {
  const f = temporaryWeb();
  try {
    mkdirSync(dirname(f.path), { recursive: true });
    writeFileSync(f.path, "x".repeat(AI_LOG_MAX_BYTES - 1));
    const logger = createAIErrorLogger({ cwd: () => f.web, production: () => false });
    logger(context);
    assert.equal(statSync(f.path + ".1").size, AI_LOG_MAX_BYTES - 1);
    assert.ok(statSync(f.path).size < 2048);
    writeFileSync(f.path, "y".repeat(AI_LOG_MAX_BYTES));
    logger(context);
    assert.equal(statSync(f.path + ".1").size, AI_LOG_MAX_BYTES);
    assert.ok(statSync(f.path).size < 2048);
    assert.deepEqual(readdirSync(dirname(f.path)).sort(), [
      "ai-error-log.txt",
      "ai-error-log.txt.1",
    ]);
  } finally {
    f.close();
  }
});

test("actual production and Vercel environment defaults route to console without resolving a filesystem path", () => {
  const web = resolve(import.meta.dirname, "../../..");
  const script = `import {createAIErrorLogger} from './src/features/chat/ai-error-log'; createAIErrorLogger({cwd:()=>{throw new Error('filesystem forbidden')}})(${JSON.stringify(context)});`;
  for (const env of [
    { NODE_ENV: "production", VERCEL: "" },
    { NODE_ENV: "development", VERCEL: "1" },
  ] as const) {
    const child = spawnSync(process.execPath, ["-e", script], {
      cwd: web,
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "");
    assert.equal(JSON.parse(child.stderr.trim()).provider, "groq");
  }
});

test("production console logging never resolves/touches local storage and logger failures are isolated", () => {
  const records: string[] = [];
  const logger = createAIErrorLogger({
    production: () => true,
    cwd: () => {
      throw new Error("must not access filesystem");
    },
    consoleError: (line) => records.push(line),
  });
  assert.doesNotThrow(() => logger(context, apiError(secret)));
  assert.equal(records.length, 1);
  assert.equal(JSON.parse(records[0]!).provider, "groq");
  assert.doesNotMatch(records[0]!, new RegExp(secret));
  assert.doesNotThrow(() =>
    createAIErrorLogger({
      production: () => true,
      consoleError: () => {
        throw new Error(secret);
      },
    })(context),
  );
  assert.doesNotThrow(() =>
    createAIErrorLogger({
      production: () => false,
      cwd: () => {
        throw new Error(secret);
      },
    })(context),
  );
  const f = temporaryWeb();
  try {
    mkdirSync(dirname(f.path), { recursive: true });
    mkdirSync(f.path); // append destination is deliberately unwritable as a file
    assert.doesNotThrow(() =>
      createAIErrorLogger({ production: () => false, cwd: () => f.web })(context),
    );
  } finally {
    f.close();
  }
});
