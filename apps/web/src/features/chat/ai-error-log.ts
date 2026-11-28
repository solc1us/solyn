// Node-only: imported by the server stream handler, never by client components.
// Node built-ins deliberately prevent this module from entering a browser bundle.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { APICallError, StreamProviderError } from "ai";
import { z } from "zod";

const tools = [
  "searchTasks",
  "searchNotes",
  "prepareTaskUpdate",
  "prepareTasks",
  "prepareProject",
  "prepareNote",
];
const fields = [
  "ordinal",
  "fieldsToChange",
  "changes",
  "title",
  "projectName",
  "status",
  "priority",
  "description",
  "assignee",
  "dueDate",
  "dueDateFrom",
  "dueDateTo",
  "overdueBefore",
  "items",
  "evidence",
  "query",
  "name",
  "content",
  "noteDate",
  "projectHint",
];
const codes = [
  "UNAUTHENTICATED",
  "UNAVAILABLE",
  "PROVIDER_CONFIGURATION",
  "PROVIDER_AUTH",
  "RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_NETWORK",
  "PROVIDER_REJECTED",
  "SEARCH_UNAVAILABLE",
  "EMPTY_RESPONSE",
  "OUTPUT_LIMIT",
  "CLIENT_ABORTED",
  "PERSISTENCE_FAILED",
];
export type DiagnosticCategory =
  | "provider_request_rejection"
  | "provider_schema_rejection"
  | "generated_argument_validation"
  | "grammar_rejection"
  | "retrieval_failure"
  | "timeout"
  | "persistence_failure"
  | "provider_failure"
  | "cancelled";
const categories: DiagnosticCategory[] = [
  "provider_request_rejection",
  "provider_schema_rejection",
  "generated_argument_validation",
  "grammar_rejection",
  "retrieval_failure",
  "timeout",
  "persistence_failure",
  "provider_failure",
  "cancelled",
];
export type AIErrorContext = {
  code: string;
  step?: number;
  tool?: string;
  category?: DiagnosticCategory;
  stage: "generation" | "retrieval" | "finalization";
  durationMs: number;
  persistence: "confirmed" | "unconfirmed" | "not_attempted";
};
export function safeAIDiagnostic(context: AIErrorContext, error?: unknown) {
  const code = codes.includes(context.code) ? context.code : "UNAVAILABLE";
  let category: DiagnosticCategory =
    context.category ??
    (code === "PROVIDER_TIMEOUT"
      ? "timeout"
      : code === "PERSISTENCE_FAILED"
        ? "persistence_failure"
        : code === "CLIENT_ABORTED"
          ? "cancelled"
          : context.stage === "retrieval"
            ? "retrieval_failure"
            : code === "PROVIDER_REJECTED"
              ? "grammar_rejection"
              : "provider_failure");
  let status: number | undefined;
  let requestId: string | undefined;
  let tool = context.tool && tools.includes(context.tool) ? context.tool : undefined;
  let schemaFields: string[] = [];
  if (APICallError.isInstance(error) || StreamProviderError.isInstance(error)) {
    if (Number.isInteger(error.statusCode) && error.statusCode! >= 100 && error.statusCode! <= 599)
      status = error.statusCode;
    // Read only known SDK metadata; never parse/serialize responseBody, data,
    // failed_generation, requestBodyValues, stacks or nested causes.
    const message = error.message.slice(0, 8192);
    const schema = /invalid JSON schema for tool\b/i.test(message);
    const argumentsInvalid = /Tool call validation failed: parameters for tool\b/i.test(message);
    category = schema
      ? "provider_schema_rejection"
      : argumentsInvalid
        ? "generated_argument_validation"
        : code === "PROVIDER_TIMEOUT" || status === 408 || status === 504
          ? "timeout"
          : status && status >= 400 && status < 500
            ? "provider_request_rejection"
            : category;
    if (schema || argumentsInvalid) {
      const named = message.match(/(?:schema for tool|parameters for tool)\s+[`'"]?(\w+)/i)?.[1];
      if (named && tools.includes(named)) tool = named;
      schemaFields = fields.filter((field) => new RegExp(`\\b${field}\\b`).test(message));
    }
    if (APICallError.isInstance(error)) {
      for (const key of ["x-request-id", "x-groq-request-id"]) {
        const value = error.responseHeaders?.[key];
        if (typeof value === "string" && /^req_[a-z0-9]{8,96}$/.test(value)) {
          requestId = value;
          break;
        }
      }
    }
  } else if (error instanceof z.ZodError) {
    schemaFields = fields.filter((field) =>
      error.issues.some((issue) => issue.path.includes(field)),
    );
  }
  return {
    timestamp: new Date().toISOString(),
    code,
    provider: "groq",
    model: "openai/gpt-oss-120b",
    category: categories.includes(category) ? category : "provider_failure",
    stage: ["generation", "retrieval", "finalization"].includes(context.stage)
      ? context.stage
      : "generation",
    persistence: ["confirmed", "unconfirmed", "not_attempted"].includes(context.persistence)
      ? context.persistence
      : "unconfirmed",
    durationMs: Number.isFinite(context.durationMs)
      ? Math.max(0, Math.min(3_600_000, Math.round(context.durationMs)))
      : 0,
    ...(context.step === 1 || context.step === 2 ? { step: context.step } : {}),
    ...(tool ? { tool } : {}),
    ...(status ? { httpStatus: status } : {}),
    ...(requestId ? { requestId } : {}),
    ...(schemaFields.length ? { schemaFields } : {}),
  };
}
export const AI_LOG_MAX_BYTES = 1_048_576;
export function aiErrorLogPath(cwd: string) {
  // bun run --filter web starts in apps/web; direct root commands start at repo root.
  const web = [resolve(cwd, "apps/web"), resolve(cwd)].find(
    (path) =>
      existsSync(join(path, "package.json")) &&
      existsSync(join(path, "src/features/chat/stream-handler.ts")),
  );
  if (!web) throw new Error("Web workspace not found");
  return join(web, "logs", "ai-error-log.txt");
}
export function createAIErrorLogger(
  options: {
    cwd?: () => string;
    production?: () => boolean;
    consoleError?: (line: string) => void;
  } = {},
) {
  return (context: AIErrorContext, error?: unknown): void => {
    try {
      const line = JSON.stringify(safeAIDiagnostic(context, error)) + "\n";
      if (
        (
          options.production ??
          (() => process.env.NODE_ENV === "production" || !!process.env.VERCEL)
        )()
      ) {
        (options.consoleError ?? console.error)(line.trimEnd());
        return;
      }
      const path = aiErrorLogPath((options.cwd ?? process.cwd)());
      mkdirSync(dirname(path), { recursive: true });
      const size = existsSync(path) ? statSync(path).size : 0;
      if (size + Buffer.byteLength(line) > AI_LOG_MAX_BYTES) {
        rmSync(path + ".1", { force: true });
        if (existsSync(path)) renameSync(path, path + ".1");
      }
      // One bounded record, one append. Rotation is best-effort for local dev,
      // not a multi-process audit log. Production/Vercel never touch this path.
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      /* Diagnostics must never alter generation/persistence/responses. */
    }
  };
}
export const logAIError = createAIErrorLogger();
