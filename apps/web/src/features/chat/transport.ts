import { z } from "zod";

import { proposalViewSchema, sourcesSchema, type ProposalView, type SourceView } from "./contracts";
import {
  managementProposalViewSchema,
  managementEqual,
  type ManagementProposalView,
} from "./management-contracts";

export const issueMessages = {
  UNAUTHENTICATED: "Sign in to continue. Your draft is still here.",
  NOT_FOUND: "This conversation or project is unavailable.",
  INVALID_INPUT: "Enter a message of up to 4,000 characters.",
  FORBIDDEN: "Open chat from the Solyn application and try again.",
  CONFLICT: "Another response may be active. Reload saved history.",
  RATE_LIMITED:
    "The provider is rate limited. Your message and any saved response remain in history.",
  PROVIDER_CONFIGURATION:
    "The AI provider is not configured. Try again after configuration is restored.",
  PROVIDER_AUTH: "The AI provider could not authenticate. Check provider configuration.",
  PROVIDER_NETWORK: "The provider could not finish. Check saved history before continuing.",
  PROVIDER_TIMEOUT: "The response timed out. Check saved history.",
  PROVIDER_REJECTED: "The provider could not process this message.",
  SEARCH_UNAVAILABLE: "Task or note search is unavailable. Try again in a new turn.",
  EMPTY_RESPONSE: "The provider returned no answer.",
  OUTPUT_LIMIT: "The answer reached its limit and is incomplete.",
  CLIENT_ABORTED: "Stop requested. Check saved history for the final status.",
  PERSISTENCE_FAILED: "Saving was not confirmed. Reload saved history before continuing.",
  NETWORK: "Connection lost. Reload saved history before retrying the same message.",
  UNEXPECTED_EOF: "The stream ended without save confirmation. Reload saved history.",
  PROTOCOL: "The response could not be verified. Reload saved history.",
  CREATION_UNCONFIRMED:
    "Chat creation was not confirmed. Check recent conversations before starting another chat.",
  UNAVAILABLE: "Chat history is unavailable. Reload saved history to try again.",
} as const;
export type Issue = keyof typeof issueMessages;
export function safeIssue(value: unknown): Issue {
  return typeof value === "string" && Object.hasOwn(issueMessages, value)
    ? (value as Issue)
    : "UNAVAILABLE";
}
export class TransportFailure extends Error {
  constructor(readonly code: Issue) {
    super("Chat transport failed.");
  }
}
const messageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  turnId: z.uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string().max(100_000),
  status: z.enum(["pending", "completed", "failed", "stopped"]),
  proposal: proposalViewSchema.nullable().optional(),
  managementProposal: managementProposalViewSchema.nullable().optional(),
  sources: sourcesSchema.default([]),
});
// Older server responses and local pending messages may omit sources.
export type WireMessage = Omit<z.infer<typeof messageSchema>, "sources"> & {
  sources?: SourceView[];
};
// null is general-chat scope; undefined is transport validation before scope is
// known. Neither bypasses structural validation or completed assistant identity.
export function sourcesMatchMessage(
  message: Pick<WireMessage, "role" | "status" | "sources" | "proposal" | "managementProposal">,
  projectId?: string | null,
) {
  const parsed = sourcesSchema.safeParse(message.sources ?? []);
  if (!parsed.success || (message.proposal && message.managementProposal)) return false;
  return (
    !parsed.data.length ||
    (message.role === "assistant" &&
      message.status === "completed" &&
      !message.proposal &&
      message.managementProposal?.kind !== "update_task" &&
      parsed.data.every(
        (source) =>
          source.state === "unavailable" || projectId == null || source.projectId === projectId,
      ))
  );
}
export function proposalMatchesMessage(
  proposal: ProposalView | null | undefined,
  message: Pick<WireMessage, "id" | "conversationId" | "turnId" | "role" | "status">,
) {
  return (
    !proposal ||
    (message.role === "assistant" &&
      message.status === "completed" &&
      proposal.sourceMessageId === message.id &&
      proposal.conversationId === message.conversationId &&
      proposal.turnId === message.turnId)
  );
}
export function managementMatchesMessage(
  proposal: ManagementProposalView | null | undefined,
  message: Pick<WireMessage, "id" | "conversationId" | "turnId" | "role" | "status">,
  projectId?: string | null,
) {
  if (!proposal) return true;
  if (
    !proposalMatchesMessageIdentity(proposal, message) ||
    (proposal.kind === "create_project" && proposal.scopedProject !== null) ||
    (projectId !== undefined && (proposal.scopedProject?.id ?? null) !== projectId)
  )
    return false;
  const draft = proposal.draft;
  if (
    draft.kind === "create_tasks" &&
    (draft.scopedProjectId !== (proposal.scopedProject?.id ?? null) ||
      !draft.items.every(
        (item, index) =>
          item.itemId === index + 1 &&
          (item.evidence.type === "user_message"
            ? item.fields.sourceNoteId === null
            : item.evidence.source.state === "unavailable"
              ? item.fields.sourceNoteId === null
              : item.fields.sourceNoteId === item.evidence.source.noteId &&
                (!draft.scopedProjectId ||
                  item.evidence.source.projectId === draft.scopedProjectId)),
      ))
  )
    return false;
  if (draft.kind === "update_task") {
    if (
      draft.target.state === "available" &&
      proposal.scopedProject &&
      draft.target.projectId !== proposal.scopedProject.id
    )
      return false;
    if (proposal.receipt?.kind === "update_task") {
      const receipt = proposal.receipt;
      if (
        receipt.version !== draft.expectedVersion + (receipt.changed ? 1 : 0) ||
        (receipt.result.state === "available" &&
          proposal.scopedProject &&
          receipt.result.projectId !== proposal.scopedProject.id) ||
        (receipt.result.state === "available" &&
          draft.target.state === "available" &&
          (receipt.result.taskId !== draft.target.taskId ||
            receipt.result.projectId !== draft.target.projectId))
      )
        return false;
    }
  }
  if (proposal.receipt?.kind === "create_tasks") {
    if (draft.kind !== "create_tasks") return false;
    const results = proposal.receipt.results;
    const available = results.filter((r) => r.state === "available");
    if (
      !results.every(
        (r, i) =>
          draft.items.some((item) => item.itemId === r.itemId) &&
          (i === 0 || r.itemId > results[i - 1]!.itemId),
      ) ||
      new Set(available.map((r) => r.taskId)).size !== available.length ||
      new Set(available.map((r) => r.projectId)).size > 1 ||
      (proposal.scopedProject && available.some((r) => r.projectId !== proposal.scopedProject!.id))
    )
      return false;
  }
  return true;
}
function proposalMatchesMessageIdentity(
  proposal: ManagementProposalView,
  message: Pick<WireMessage, "id" | "conversationId" | "turnId" | "role" | "status">,
) {
  return (
    message.role === "assistant" &&
    message.status === "completed" &&
    proposal.sourceMessageId === message.id &&
    proposal.conversationId === message.conversationId &&
    proposal.turnId === message.turnId
  );
}
export type Attempt = { conversationId: string; turnId: string; content: string };
export type StreamEvent = { event: string; data: string };

// SSE line endings and UTF-8 characters may both straddle network chunks.
// An unterminated frame at EOF is intentionally not dispatched.
export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let frameSize = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new TransportFailure("CLIENT_ABORTED");
    while (true) {
      const part = await reader.read();
      buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
      while (true) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0 || (!part.done && buffer[end] === "\r" && end === buffer.length - 1)) break;
        if (end + frameSize > 262_144) throw new TransportFailure("PROTOCOL");
        const line = buffer.slice(0, end);
        const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(end + width);
        if (!line) {
          if (data.length) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
          frameSize = 0;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "event") event = value;
          if (field === "data") {
            data.push(value);
            frameSize += value.length + 1;
          }
          if (frameSize > 262_144) throw new TransportFailure("PROTOCOL");
        }
      }
      if (buffer.length + frameSize > 262_144) throw new TransportFailure("PROTOCOL");
      if (part.done) break;
    }
    if (signal.aborted) throw new TransportFailure("CLIENT_ABORTED");
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Outcome =
  | {
      kind: "finish";
      messageId: string;
      proposal: ProposalView | null;
      managementProposal: ManagementProposalView | null;
      sources: SourceView[];
    }
  | { kind: "replay"; user: WireMessage; assistant: WireMessage; abandoned: boolean }
  | { kind: "error"; code: Issue; confirmed: boolean; status?: "failed" | "stopped" }
  | { kind: "rejected"; code: Issue };
export async function consumeChatResponse(
  response: Response,
  attempt: Attempt,
  update: (event: { type: "start" } | { type: "delta"; text: string }) => void,
  signal: AbortSignal,
): Promise<Outcome> {
  const type = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (type === "application/json") {
    const body = await response.json();
    if (!response.ok || body?.ok === false)
      return { kind: "rejected", code: safeIssue(body?.error?.code) };
    const parsed = z
      .object({
        ok: z.literal(true),
        replayed: z.literal(true),
        abandoned: z.boolean(),
        user: messageSchema,
        assistant: messageSchema,
        proposal: proposalViewSchema.nullable().default(null),
        managementProposal: managementProposalViewSchema.nullable().default(null),
      })
      .safeParse(body);
    if (!parsed.success) throw new TransportFailure("PROTOCOL");
    const { user, assistant, abandoned, proposal, managementProposal } = parsed.data;
    if (
      [user, assistant].some(
        (m) => m.conversationId !== attempt.conversationId || m.turnId !== attempt.turnId,
      ) ||
      user.role !== "user" ||
      user.status !== "completed" ||
      user.content !== attempt.content ||
      assistant.role !== "assistant" ||
      assistant.id === user.id ||
      user.proposal ||
      user.managementProposal ||
      !sourcesMatchMessage(user) ||
      !sourcesMatchMessage({ ...assistant, proposal, managementProposal }) ||
      !managementMatchesMessage(managementProposal, assistant) ||
      (assistant.managementProposal &&
        !managementEqual(assistant.managementProposal, managementProposal)) ||
      (!!assistant.proposal && !!managementProposal) ||
      (!!assistant.managementProposal && !!proposal) ||
      !proposalMatchesMessage(proposal, assistant) ||
      (assistant.proposal && assistant.proposal.id !== proposal?.id)
    )
      throw new TransportFailure("PROTOCOL");
    return {
      kind: "replay",
      user,
      assistant: { ...assistant, proposal, managementProposal },
      abandoned,
    };
  }
  if (!response.ok || type !== "text/event-stream" || !response.body)
    throw new TransportFailure("NETWORK");
  let started = false;
  let length = 0;
  for await (const frame of parseSSE(response.body, signal)) {
    if (!["start", "text-delta", "finish", "error"].includes(frame.event)) continue;
    const body = JSON.parse(frame.data);
    if (frame.event === "start") {
      if (
        started ||
        body.conversationId !== attempt.conversationId ||
        body.turnId !== attempt.turnId
      )
        throw new TransportFailure("PROTOCOL");
      started = true;
      update({ type: "start" });
    } else if (frame.event === "text-delta") {
      if (!started || typeof body.text !== "string") throw new TransportFailure("PROTOCOL");
      length += body.text.length;
      if (length > 20_000) throw new TransportFailure("PROTOCOL");
      update({ type: "delta", text: body.text });
    } else if (frame.event === "finish") {
      const parsed = z
        .object({
          turnId: z.literal(attempt.turnId),
          status: z.literal("completed"),
          persisted: z.literal(true),
          messageId: z.uuid(),
          proposal: proposalViewSchema.nullable().default(null),
          managementProposal: managementProposalViewSchema.nullable().default(null),
          sources: sourcesSchema.default([]),
        })
        .safeParse(body);
      if (!started || !length || !parsed.success) throw new TransportFailure("PROTOCOL");
      if (
        !proposalMatchesMessage(parsed.data.proposal, {
          ...attempt,
          id: parsed.data.messageId,
          role: "assistant",
          status: "completed",
        })
      )
        throw new TransportFailure("PROTOCOL");
      if (
        !managementMatchesMessage(parsed.data.managementProposal, {
          ...attempt,
          id: parsed.data.messageId,
          role: "assistant",
          status: "completed",
        })
      )
        throw new TransportFailure("PROTOCOL");
      if (!sourcesMatchMessage({ ...parsed.data, role: "assistant" }))
        throw new TransportFailure("PROTOCOL");
      return {
        kind: "finish",
        messageId: parsed.data.messageId,
        proposal: parsed.data.proposal,
        managementProposal: parsed.data.managementProposal,
        sources: parsed.data.sources,
      };
    } else {
      const parsed = z
        .object({
          code: z.string(),
          persistence: z.enum(["confirmed", "unconfirmed"]),
          status: z.enum(["failed", "stopped"]).optional(),
        })
        .safeParse(body);
      if (!started || !parsed.success) throw new TransportFailure("PROTOCOL");
      return {
        kind: "error",
        code: safeIssue(parsed.data.code),
        confirmed: parsed.data.persistence === "confirmed",
        status: parsed.data.status,
      };
    }
  }
  throw new TransportFailure("UNEXPECTED_EOF");
}
