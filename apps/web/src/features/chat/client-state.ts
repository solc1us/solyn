import type { createConversation, getConversation } from "./actions";
import { proposalViewSchema, streamTurnInput, type ProposalView } from "./contracts";
import {
  consumeChatResponse,
  proposalMatchesMessage,
  safeIssue,
  TransportFailure,
  type Attempt,
  type Issue,
  type WireMessage,
} from "./transport";

export type ChatView = Extract<Awaited<ReturnType<typeof getConversation>>, { ok: true }>["data"];
export type ProjectScope = { id: string; name: string } | null;
export type UiMessage = WireMessage & { persisted: boolean };
export type ProposalEdit = { projectId: string; title: string; content: string; noteDate: string };
export function originalProposalEdit(proposal: ProposalView): ProposalEdit {
  return {
    projectId: proposal.scopedProject?.id ?? "",
    title: proposal.draft.title,
    content: proposal.draft.content,
    noteDate: proposal.draft.noteDate ?? "",
  };
}
export function proposalEditDirty(proposal: ProposalView, edit?: ProposalEdit) {
  return !!edit && JSON.stringify(originalProposalEdit(proposal)) !== JSON.stringify(edit);
}
export type SessionState = {
  conversation: ChatView["conversation"] | null;
  project: ProjectScope;
  messages: UiMessage[];
  draft: string;
  phase: "idle" | "creating" | "sending" | "streaming" | "stopping" | "reloading";
  issue: Issue | null;
  needsReconcile: boolean;
  creationUnconfirmed: boolean;
  attempt: Attempt | null;
  pendingTurn: ChatView["pendingTurn"];
  hasOlder: boolean;
  viewingOlder: boolean;
  proposalEdits: Record<string, ProposalEdit>;
};
export function shouldSend(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode?: number;
}) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}
export function messageStatus(message: UiMessage, busy: boolean) {
  if (!message.persisted) return busy ? "Not yet saved" : "Save unconfirmed";
  return { completed: "Saved", pending: "Pending", failed: "Failed", stopped: "Stopped" }[
    message.status
  ];
}
export class ChatSessions {
  private sessions = new Map<string, ChatSession>();
  select(key: string, create: () => ChatSession) {
    const found = this.sessions.get(key);
    if (found) return found;
    const session = create();
    if (this.sessions.size >= 10) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(key, session);
    return session;
  }
  promote(key: string, id: string, session: ChatSession) {
    this.sessions.delete(key);
    this.sessions.set(`conversation:${id}`, session);
  }
}
export function conversationTitle(content: string) {
  return Array.from(content.trim().replace(/\s+/g, " ")).slice(0, 80).join("");
}
export function mergeMessages(first: UiMessage[], second: UiMessage[]) {
  const replaced = new Set(second.map((m) => `${m.turnId}:${m.role}`));
  return [...first.filter((m) => !replaced.has(`${m.turnId}:${m.role}`)), ...second];
}
const savedMessages = (view: ChatView) => {
  const ids = new Set<string>();
  return view.messages.map((m) => {
    const proposal = m.proposal ? proposalViewSchema.parse(m.proposal) : null;
    if (
      m.conversationId !== view.conversation.id ||
      !proposalMatchesMessage(proposal, m) ||
      (proposal && ids.has(proposal.id))
    )
      throw new TransportFailure("PROTOCOL");
    if (proposal) ids.add(proposal.id);
    return { ...m, proposal, persisted: true };
  });
};

// A small per-view state machine, not an inference retry layer. Instances live
// only inside the mounted chat screen; no browser storage or shared user cache.
export class ChatSession {
  private state: SessionState;
  private listeners = new Set<() => void>();
  private abortController: AbortController | null = null;
  private conversationId: string | null;
  private olderOffset = 0;
  constructor(
    private dependencies: {
      create: typeof createConversation;
      read: typeof getConversation;
      fetch: typeof globalThis.fetch;
      uuid: () => string;
      created: (id: string) => void;
      changed: () => void;
    },
    input: {
      conversationId?: string;
      project: ProjectScope;
      initial?: Awaited<ReturnType<typeof getConversation>>;
    },
  ) {
    this.conversationId = input.conversationId ?? null;
    let view = input.initial?.ok ? input.initial.data : null;
    let initialMessages: UiMessage[] = [];
    try {
      if (view) initialMessages = savedMessages(view);
    } catch {
      view = null;
    }
    this.olderOffset = view?.messages.length ?? 0;
    this.state = {
      conversation: view?.conversation ?? null,
      project: view?.project ?? input.project,
      messages: initialMessages,
      draft: "",
      phase: "idle",
      issue: input.initial && !input.initial.ok ? input.initial.error.code : null,
      needsReconcile: !!input.conversationId && !view,
      creationUnconfirmed: false,
      attempt: null,
      pendingTurn: view?.pendingTurn ?? null,
      hasOlder: (view?.messages.length ?? 0) === 50,
      viewingOlder: false,
      proposalEdits: {},
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(update: Partial<SessionState>) {
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  setDraft(value: string) {
    this.set({ draft: value });
  }
  editProposal(id: string, patch: Partial<ProposalEdit>) {
    const proposal = this.state.messages.find(
      (m) => m.persisted && m.proposal?.id === id,
    )?.proposal;
    if (!proposal || proposal.status !== "proposed") return;
    const next = { ...(this.state.proposalEdits[id] ?? originalProposalEdit(proposal)), ...patch };
    const edits = { ...this.state.proposalEdits };
    if (proposalEditDirty(proposal, next)) edits[id] = next;
    else delete edits[id];
    this.set({ proposalEdits: edits });
  }
  get hasProposalChanges() {
    return Object.keys(this.state.proposalEdits).length > 0;
  }
  get busy() {
    return this.state.phase !== "idle";
  }
  get canSend() {
    return (
      !this.busy &&
      !this.state.viewingOlder &&
      !this.state.creationUnconfirmed &&
      !this.state.needsReconcile &&
      (!this.state.pendingTurn || this.state.pendingTurn.abandoned) &&
      (!this.state.attempt || this.state.pendingTurn?.abandoned === true)
    );
  }
  get canRetry() {
    return (
      !this.busy &&
      !this.state.viewingOlder &&
      !!this.state.attempt &&
      !this.state.needsReconcile &&
      !this.state.pendingTurn
    );
  }
  stop() {
    if (!this.abortController) return;
    this.set({ phase: "stopping" });
    this.abortController.abort();
  }
  async reload(older = false, discardProposalEdits = true) {
    if (this.busy || !this.conversationId) return;
    this.set({ phase: "reloading" });
    try {
      await this.reconcile(older);
      if (!older && discardProposalEdits && !this.state.needsReconcile)
        this.set({ proposalEdits: {} });
    } finally {
      this.set({ phase: "idle" });
    }
  }
  adopt(initial: Awaited<ReturnType<typeof getConversation>>) {
    if (this.busy) return;
    if (initial.ok) {
      if (initial.data.conversation.id !== this.conversationId) return;
      const terminal = [...this.state.messages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" && message.persisted && message.status !== "pending",
        );
      const observed =
        terminal &&
        initial.data.messages.find(
          (message) => message.turnId === terminal.turnId && message.role === "assistant",
        );
      // An RSC read can have started before an acknowledged terminal commit.
      // Read again after that acknowledgement instead of downgrading saved UI.
      if (terminal && (!observed || observed.status === "pending")) {
        void this.reload(false, false);
        return;
      }
    }
    void this.reconcile(false, initial);
  }
  private async reconcile(older = false, initial?: Awaited<ReturnType<typeof getConversation>>) {
    if (!this.conversationId) return;
    try {
      const offset = older ? this.olderOffset : 0;
      const result =
        initial ??
        (await this.dependencies.read({
          conversationId: this.conversationId,
          latest: true,
          limit: 50,
          offset,
        }));
      if (!result.ok) {
        this.set({
          issue: result.error.code,
          needsReconcile: true,
        });
        return;
      }
      const view = result.data;
      const page = savedMessages(view).map((message) => {
        const local = this.state.messages.find(
          (row) => row.turnId === message.turnId && row.role === message.role,
        );
        return message.role === "assistant" &&
          message.status === "pending" &&
          local &&
          !local.persisted &&
          local.content
          ? { ...message, content: local.content, persisted: false }
          : message;
      });
      const previous = this.state.messages.filter((m) => m.persisted);
      this.olderOffset = offset + page.length;
      let messages = older ? mergeMessages(page, previous).slice(0, 500) : page;
      const attempt = this.state.attempt;
      const pair = attempt ? messages.filter((m) => m.turnId === attempt.turnId) : [];
      const resolved =
        pair.some((m) => m.role === "user") &&
        pair.some((m) => m.role === "assistant" && m.status !== "pending");
      // Keep uncertain local text visible if no saved row has yet confirmed it.
      if (attempt)
        messages = mergeMessages(
          messages,
          this.state.messages.filter(
            (m) =>
              m.turnId === attempt.turnId &&
              !messages.some((saved) => saved.turnId === m.turnId && saved.role === m.role),
          ),
        );
      this.set({
        conversation: view.conversation,
        project: view.project,
        messages,
        pendingTurn: view.pendingTurn,
        needsReconcile: false,
        attempt: resolved ? null : attempt,
        hasOlder: page.length === 50 && this.olderOffset <= 100_000,
        viewingOlder: older,
        issue:
          pair.some(
            (m) => m.role === "assistant" && (m.status === "failed" || m.status === "stopped"),
          ) ||
          (attempt && !resolved)
            ? this.state.issue
            : null,
      });
    } catch {
      this.set({
        issue: "UNAVAILABLE",
        needsReconcile: true,
      });
    }
  }
  async submit(retry = false) {
    if (retry ? !this.canRetry : !this.canSend) return;
    const content = retry ? this.state.attempt!.content : this.state.draft;
    // Validate before conversation creation; the backend independently validates.
    const validation = streamTurnInput.shape.content.safeParse(content);
    if (!validation.success) {
      this.set({ issue: "INVALID_INPUT" });
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    this.set({
      phase: this.conversationId ? "sending" : "creating",
      issue: null,
      draft: retry ? this.state.draft : "",
    });
    let confirmed = false;
    let submitted = false;
    try {
      if (!this.conversationId) {
        let created;
        try {
          created = await this.dependencies.create({
            title: conversationTitle(content),
            projectId: this.state.project?.id ?? null,
          });
        } catch {
          this.set({ creationUnconfirmed: true, issue: "CREATION_UNCONFIRMED" });
          return;
        }
        if (!created.ok) {
          this.set({
            issue:
              created.error.code === "UNAVAILABLE" ? "CREATION_UNCONFIRMED" : created.error.code,
            creationUnconfirmed: created.error.code === "UNAVAILABLE",
          });
          return;
        }
        this.conversationId = created.data.id;
        this.set({ conversation: created.data });
        this.dependencies.created(created.data.id);
      }
      if (controller.signal.aborted) {
        this.set({ issue: "CLIENT_ABORTED" });
        return;
      }
      const attempt = retry
        ? this.state.attempt!
        : { conversationId: this.conversationId, turnId: this.dependencies.uuid(), content };
      const local: UiMessage[] = [
        {
          ...attempt,
          id: `local-user-${attempt.turnId}`,
          role: "user",
          status: "completed",
          persisted: false,
        },
        {
          ...attempt,
          id: `local-assistant-${attempt.turnId}`,
          role: "assistant",
          status: "pending",
          content: "",
          persisted: false,
        },
      ];
      submitted = true;
      this.set({
        attempt,
        messages: mergeMessages(this.state.messages, local).slice(-500),
        phase: "sending",
        needsReconcile: true,
      });
      const response = await this.dependencies.fetch("/api/chat/stream", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(attempt),
        signal: controller.signal,
      });
      const outcome = await consumeChatResponse(
        response,
        attempt,
        (event) => {
          if (event.type === "start")
            this.set({
              phase: "streaming",
              messages: this.state.messages.map((m) =>
                m.turnId === attempt.turnId && m.role === "user" ? { ...m, persisted: true } : m,
              ),
            });
          else
            this.set({
              messages: this.state.messages.map((m) =>
                m.turnId === attempt.turnId && m.role === "assistant"
                  ? { ...m, content: m.content + event.text }
                  : m,
              ),
            });
        },
        controller.signal,
      );
      if (outcome.kind === "finish") {
        confirmed = true;
        this.set({
          attempt: null,
          pendingTurn: null,
          needsReconcile: false,
          messages: this.state.messages.map((m) =>
            m.turnId === attempt.turnId
              ? {
                  ...m,
                  persisted: true,
                  id: m.role === "assistant" ? outcome.messageId : m.id,
                  status: "completed",
                  proposal: m.role === "assistant" ? outcome.proposal : null,
                }
              : m,
          ),
        });
      } else if (outcome.kind === "replay") {
        const terminal = outcome.assistant.status !== "pending";
        confirmed = terminal;
        this.set({
          messages: mergeMessages(
            this.state.messages,
            [outcome.user, outcome.assistant].map((m) => ({ ...m, persisted: true })),
          ),
          pendingTurn: terminal ? null : { turnId: attempt.turnId, abandoned: outcome.abandoned },
          attempt: terminal ? null : attempt,
          needsReconcile: false,
        });
      } else {
        this.set({ issue: safeIssue(outcome.code) });
        if (outcome.kind === "error" && outcome.confirmed && outcome.status) {
          this.set({
            messages: this.state.messages.map((m) =>
              m.turnId === attempt.turnId
                ? {
                    ...m,
                    persisted: true,
                    status: m.role === "assistant" ? outcome.status! : "completed",
                  }
                : m,
            ),
          });
        }
      }
    } catch (error) {
      this.set({
        issue: controller.signal.aborted
          ? "CLIENT_ABORTED"
          : error instanceof TransportFailure
            ? error.code
            : "NETWORK",
      });
    } finally {
      // Reads are recovery, never a second inference. Do not clear the attempt
      // merely because a request ended or a snapshot has not observed its commit.
      if (this.conversationId && !confirmed) await this.reconcile();
      if (!submitted && !retry && !this.state.draft) this.set({ draft: content });
      this.abortController = null;
      this.set({ phase: "idle" });
      this.dependencies.changed();
    }
  }
}
