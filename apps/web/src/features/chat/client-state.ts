import type { createConversation, getConversation, getNoteProposal } from "./actions";
import type { confirmNoteProposal } from "../workspace/actions";
import {
  confirmNoteProposalInput,
  confirmationReceiptSchema,
  proposalViewSchema,
  sourcesSchema,
  streamTurnInput,
  type ConfirmNoteProposalInput,
  type ProposalView,
} from "./contracts";
import {
  consumeChatResponse,
  proposalMatchesMessage,
  sourcesMatchMessage,
  safeIssue,
  TransportFailure,
  type Attempt,
  type Issue,
  type WireMessage,
} from "./transport";

export type ChatView = Extract<Awaited<ReturnType<typeof getConversation>>, { ok: true }>["data"];
export type ProjectScope = { id: string; name: string } | null;
// Ephemeral, allowlisted display reason only; never persisted as assistant text.
export type UiMessage = WireMessage & { persisted: boolean; failure?: Issue };
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
export type ProposalSave = {
  phase: "saving" | "checking" | "uncertain" | "retry" | "error";
  payload: ConfirmNoteProposalInput;
  proposal: ProposalView;
  issue: Issue | null;
};
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
  proposalSaves: Record<string, ProposalSave>;
  proposalReceipts: Record<string, ProposalView>;
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
export function isGenerationFailure(issue: Issue | null) {
  return (
    issue !== null &&
    [
      "RATE_LIMITED",
      "PROVIDER_TIMEOUT",
      "PROVIDER_NETWORK",
      "PROVIDER_REJECTED",
      "EMPTY_RESPONSE",
      "OUTPUT_LIMIT",
    ].includes(issue)
  );
}
export function replyFailureNotice(
  message: UiMessage,
  recoveryRequired: boolean,
  canSend: boolean,
) {
  if (message.role !== "assistant" || !message.persisted || message.status !== "failed")
    return null;
  const reason = message.failure;
  const base =
    reason === "RATE_LIMITED"
      ? "Solyn is temporarily busy."
      : reason === "PROVIDER_TIMEOUT"
        ? "Solyn took too long to respond."
        : reason === "PROVIDER_AUTH" || reason === "PROVIDER_CONFIGURATION"
          ? "Solyn is unavailable until its provider configuration is restored."
          : "Solyn couldn't complete this reply.";
  const partial = message.content ? " The text above is incomplete." : "";
  if (recoveryRequired) return `${base}${partial} Reload saved history before continuing.`;
  if (reason === "PROVIDER_AUTH" || reason === "PROVIDER_CONFIGURATION" || !canSend)
    return `${base}${partial}`;
  return `${base}${partial} ${reason === "RATE_LIMITED" ? "Please try again later." : reason === "PROVIDER_TIMEOUT" ? "Please try again." : "Please send your message again."}`;
}
export class ChatSessions {
  private sessions = new Map<string, ChatSession>();
  private deleted = new Set<string>();
  isDeleted(id: string) {
    return this.deleted.has(id);
  }
  remove(id: string) {
    this.deleted.add(id);
    for (const [key, session] of this.sessions) {
      if (key === `conversation:${id}` || session.getSnapshot().conversation?.id === id) {
        session.retire();
        this.sessions.delete(key);
      }
    }
  }
  rename(id: string, title: string) {
    if (this.deleted.has(id)) return;
    for (const session of this.sessions.values()) session.renameTitle(id, title);
  }
  select(key: string, create: () => ChatSession) {
    if (key.startsWith("conversation:") && this.deleted.has(key.slice("conversation:".length))) {
      const retired = create();
      retired.retire();
      return retired;
    }
    const found = this.sessions.get(key);
    // Selection can run more than once during render (including StrictMode).
    // Only the committed view lifecycle may invalidate/publish session state.
    if (found) return found;
    const session = create();
    if (this.sessions.size >= 10) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(key, session);
    return session;
  }
  promote(key: string, id: string, session: ChatSession) {
    this.sessions.delete(key);
    if (this.deleted.has(id)) {
      session.retire();
      return false;
    }
    this.sessions.set(`conversation:${id}`, session);
    return true;
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
    const sources = sourcesSchema.parse(m.sources ?? []);
    if (
      !sourcesMatchMessage({ ...m, proposal, sources }, view.conversation.projectId) ||
      m.conversationId !== view.conversation.id ||
      !proposalMatchesMessage(proposal, m) ||
      (proposal && ids.has(proposal.id))
    )
      throw new TransportFailure("PROTOCOL");
    if (proposal) ids.add(proposal.id);
    return { ...m, proposal, sources, persisted: true };
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
  private sourceRead = 0;
  private sourceEpoch = 0;
  private retired = false;
  private titleRevision = 0;
  constructor(
    private dependencies: {
      create: typeof createConversation;
      confirm?: typeof confirmNoteProposal;
      recoverProposal?: typeof getNoteProposal;
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
      if (view) {
        if (input.conversationId && view.conversation.id !== input.conversationId)
          throw new TransportFailure("PROTOCOL");
        initialMessages = savedMessages(view);
      }
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
      proposalSaves: {},
      proposalReceipts: Object.fromEntries(
        initialMessages
          .filter((m) => m.proposal?.status === "confirmed")
          .map((m) => [m.proposal!.id, m.proposal!]),
      ),
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  // An acknowledged permanent delete retires the whole view, including receipts.
  // Late reads/streams/confirmation acknowledgements cannot resurrect it.
  retire() {
    if (this.retired) return;
    this.retired = true;
    this.sourceRead++;
    this.sourceEpoch++;
    this.abortController?.abort();
    this.abortController = null;
    this.state = {
      ...this.state,
      conversation: null,
      project: null,
      messages: [],
      draft: "",
      phase: "idle",
      issue: null,
      needsReconcile: false,
      creationUnconfirmed: false,
      attempt: null,
      pendingTurn: null,
      hasOlder: false,
      viewingOlder: false,
      proposalEdits: {},
      proposalSaves: {},
      proposalReceipts: {},
    };
    for (const listener of this.listeners) listener();
  }
  renameTitle(id: string, title: string) {
    if (this.state.conversation?.id === id) {
      this.titleRevision++;
      this.set({ conversation: { ...this.state.conversation, title } });
    }
  }
  private set(update: Partial<SessionState>) {
    if (this.retired) return;
    const receipts = { ...this.state.proposalReceipts, ...update.proposalReceipts };
    const incoming = update.messages ?? (update.proposalReceipts ? this.state.messages : undefined);
    if (incoming) {
      for (const m of incoming)
        if (m.proposal?.status === "confirmed") {
          const prior = receipts[m.proposal.id];
          if (prior && JSON.stringify(prior.receipt) !== JSON.stringify(m.proposal.receipt))
            throw new TransportFailure("PROTOCOL");
          receipts[m.proposal.id] = m.proposal;
        }
      update.messages = incoming.map((m) => {
        const receipt = Object.values(receipts).find((p) => p.sourceMessageId === m.id);
        if (!receipt) return m;
        if (!proposalMatchesMessage(receipt, { ...m, status: "completed" }))
          throw new TransportFailure("PROTOCOL");
        return { ...m, proposal: receipt, status: "completed" as const, persisted: true };
      });
    }
    // Explicit reload can clear edits; confirmed receipts always clear their edit
    // and pending-operation state, even if an older RSC/history response arrives.
    const nextEdits = { ...(update.proposalEdits ?? this.state.proposalEdits) };
    const saves = { ...(update.proposalSaves ?? this.state.proposalSaves) };
    for (const id of Object.keys(receipts)) {
      delete nextEdits[id];
      delete saves[id];
    }
    this.state = {
      ...this.state,
      ...update,
      proposalEdits: nextEdits,
      proposalSaves: saves,
      proposalReceipts: receipts,
    };
    for (const listener of this.listeners) listener();
  }
  setDraft(value: string) {
    this.set({ draft: value });
  }
  editProposal(id: string, patch: Partial<ProposalEdit>) {
    if (
      this.state.proposalReceipts[id] ||
      (this.state.proposalSaves[id] && this.state.proposalSaves[id].phase !== "error")
    )
      return;
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
    return (
      Object.keys(this.state.proposalEdits).length > 0 ||
      Object.values(this.state.proposalSaves).some((save) => save.phase !== "error")
    );
  }
  private saveState(id: string, save: ProposalSave) {
    if (!this.state.proposalReceipts[id])
      this.set({ proposalSaves: { ...this.state.proposalSaves, [id]: save } });
  }
  private acceptConfirmed(value: ProposalView, expected: ProposalView) {
    if (
      value.id !== expected.id ||
      value.sourceMessageId !== expected.sourceMessageId ||
      value.conversationId !== expected.conversationId ||
      value.turnId !== expected.turnId ||
      value.status !== "confirmed" ||
      !value.receipt
    )
      throw new TransportFailure("PROTOCOL");
    this.set({ proposalReceipts: { ...this.state.proposalReceipts, [value.id]: value } });
  }
  async confirmProposal(id: string) {
    if (this.retired) return;
    if (this.state.proposalReceipts[id]) return;
    const previous = this.state.proposalSaves[id];
    if (previous && previous.phase !== "retry" && previous.phase !== "error") return;
    const proposal =
      this.state.messages.find(
        (m) => m.persisted && m.status === "completed" && m.proposal?.id === id,
      )?.proposal ?? previous?.proposal;
    if (!proposal || proposal.status !== "proposed") return;
    const edit = this.state.proposalEdits[id] ?? originalProposalEdit(proposal);
    const parsed = confirmNoteProposalInput.safeParse({
      proposalId: id,
      projectId: edit.projectId,
      title: edit.title,
      content: edit.content,
      noteDate: edit.noteDate || null,
    });
    if (!parsed.success && previous?.phase !== "retry") return;
    const payload = previous?.phase === "retry" ? previous.payload : parsed.data!;
    const save: ProposalSave = { phase: "saving", proposal, payload, issue: null };
    this.saveState(id, save); // Synchronous guard, before the first await/double click.
    try {
      if (!this.dependencies.confirm) throw new TransportFailure("UNAVAILABLE");
      const result = await this.dependencies.confirm(payload);
      if (this.state.proposalReceipts[id]) return;
      if (!result.ok) {
        if (result.error.code === "UNAVAILABLE" || previous?.phase === "retry")
          throw new TransportFailure("UNAVAILABLE");
        this.saveState(id, { ...save, phase: "error", issue: safeIssue(result.error.code) });
        return;
      }
      const receipt = confirmationReceiptSchema.parse(result.data);
      if (receipt.proposalId !== id || receipt.projectId !== payload.projectId)
        throw new TransportFailure("PROTOCOL");
      this.acceptConfirmed(
        {
          ...proposal,
          status: "confirmed",
          receipt: { noteId: receipt.noteId, projectId: receipt.projectId, href: receipt.href },
        },
        proposal,
      );
    } catch {
      if (this.state.proposalReceipts[id]) return;
      this.saveState(id, { ...save, phase: "uncertain", issue: "UNAVAILABLE" });
      await this.recoverProposal(id); // Read only; never automatically resubmit.
    }
  }
  async recoverProposal(id: string) {
    if (this.retired) return;
    const save = this.state.proposalSaves[id];
    if (
      !save ||
      save.phase === "saving" ||
      save.phase === "checking" ||
      this.state.proposalReceipts[id]
    )
      return;
    this.saveState(id, { ...save, phase: "checking" });
    try {
      if (!this.dependencies.recoverProposal) throw new TransportFailure("UNAVAILABLE");
      const result = await this.dependencies.recoverProposal({ proposalId: id });
      if (this.state.proposalReceipts[id]) return;
      if (!result.ok) {
        this.saveState(id, { ...save, phase: "uncertain", issue: safeIssue(result.error.code) });
        return;
      }
      const view = proposalViewSchema.parse(result.data);
      if (
        view.id !== id ||
        !proposalMatchesMessage(view, {
          id: save.proposal.sourceMessageId,
          conversationId: save.proposal.conversationId,
          turnId: save.proposal.turnId,
          role: "assistant",
          status: "completed",
        })
      )
        throw new TransportFailure("PROTOCOL");
      if (view.status === "confirmed") this.acceptConfirmed(view, save.proposal);
      else
        this.saveState(id, {
          ...save,
          phase: save.phase === "error" ? "error" : "retry",
          issue: save.phase === "error" ? save.issue : null,
        });
    } catch {
      this.saveState(id, { ...save, phase: "uncertain", issue: "UNAVAILABLE" });
    }
  }
  get busy() {
    return this.state.phase !== "idle";
  }
  get canSend() {
    return (
      !this.retired &&
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
      !this.retired &&
      !this.busy &&
      !this.state.viewingOlder &&
      !!this.state.attempt &&
      !this.state.needsReconcile &&
      !this.state.pendingTurn
    );
  }
  // Called on committed session switches, before paint, or before a fresh read.
  invalidateSources() {
    if (this.retired || !this.conversationId) return;
    this.sourceRead++;
    this.sourceEpoch++;
    this.set({
      messages: this.state.messages.map((message) => ({ ...message, sources: [] })),
      needsReconcile: true,
    });
  }
  stop() {
    if (!this.abortController) return;
    this.set({ phase: "stopping" });
    this.abortController.abort();
  }
  async reload(older = false, discardProposalEdits = true) {
    if (this.retired || this.busy || !this.conversationId) return;
    const sourceEpoch = this.sourceEpoch;
    this.set({ phase: "reloading" });
    try {
      await this.reconcile(older);
      if (!older && discardProposalEdits && !this.state.needsReconcile)
        this.set({ proposalEdits: {} });
    } finally {
      this.set({ phase: "idle" });
      // A cached-session return may have invalidated an outstanding older-page
      // read. Its result is ignored; refresh after it settles, never resurrect it.
      if (sourceEpoch !== this.sourceEpoch) void this.reload(false, false);
    }
  }
  adopt(initial: Awaited<ReturnType<typeof getConversation>>) {
    if (this.retired || this.busy) return;
    if (initial.ok && initial.data.conversation.id !== this.conversationId) return;
    if (
      this.state.messages.some((message) => message.sources?.length) ||
      (initial.ok && initial.data.messages.some((message) => message.sources?.length))
    ) {
      // A route snapshot has no authorization freshness marker. Never let it
      // restore a link after a newer action read has revoked/cleared that source.
      this.invalidateSources();
      void this.reload(false, false);
      return;
    }
    if (initial.ok) {
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
    if (this.retired || !this.conversationId) return;
    const read = ++this.sourceRead;
    const titleRevision = this.titleRevision;
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
      if (read !== this.sourceRead) return;
      if (!result.ok) {
        this.set({
          messages: this.state.messages.map((message) => ({ ...message, sources: [] })),
          issue: result.error.code,
          needsReconcile: true,
        });
        return;
      }
      const view = result.data;
      if (view.conversation.id !== this.conversationId) throw new TransportFailure("PROTOCOL");
      const page = savedMessages(view).map((message) => {
        const local = this.state.messages.find(
          (row) => row.turnId === message.turnId && row.role === message.role,
        );
        if (message.role === "assistant" && message.status === "failed" && local?.failure)
          return { ...message, failure: local.failure };
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
      // Replace projections, including []/unavailable, without changing existing
      // message ordering or the proposal receipt safeguards. Superseded reads above
      // cannot restore an older authorization result.
      const projections = new Map(page.map((message) => [message.id, message.sources]));
      messages = messages.map((message) =>
        projections.has(message.id)
          ? { ...message, sources: projections.get(message.id) }
          : message,
      );
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
        // RSC has no read-start marker. Preserve an acknowledged title against
        // route snapshots and reads started before rename, not later fresh reads.
        conversation:
          this.state.conversation &&
          (titleRevision !== this.titleRevision || (!!initial && this.titleRevision > 0))
            ? { ...view.conversation, title: this.state.conversation.title }
            : view.conversation,
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
      if (read !== this.sourceRead) return;
      this.set({
        messages: this.state.messages.map((message) => ({ ...message, sources: [] })),
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
    const sourceEpoch = this.sourceEpoch;
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
        if (this.retired) return;
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
      if (this.retired) return;
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
        if (
          !sourcesMatchMessage(
            {
              role: "assistant",
              status: "completed",
              sources: outcome.sources,
              proposal: outcome.proposal,
            },
            this.state.conversation?.projectId ?? this.state.project?.id ?? null,
          ) ||
          this.state.messages.some(
            (message) =>
              message.id === outcome.messageId &&
              (message.turnId !== attempt.turnId || message.role !== "assistant"),
          )
        )
          throw new TransportFailure("PROTOCOL");
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
                  sources:
                    m.role === "assistant" && sourceEpoch === this.sourceEpoch
                      ? outcome.sources
                      : [],
                }
              : m,
          ),
        });
      } else if (outcome.kind === "replay") {
        if (
          !sourcesMatchMessage(
            outcome.assistant,
            this.state.conversation?.projectId ?? this.state.project?.id ?? null,
          )
        )
          throw new TransportFailure("PROTOCOL");
        const terminal = outcome.assistant.status !== "pending";
        confirmed = terminal;
        this.set({
          messages: mergeMessages(
            this.state.messages,
            [outcome.user, outcome.assistant].map((m) => ({
              ...m,
              sources: sourceEpoch === this.sourceEpoch ? (m.sources ?? []) : [],
              persisted: true,
            })),
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
                    ...(m.role === "assistant" && outcome.status === "failed"
                      ? { failure: safeIssue(outcome.code) }
                      : {}),
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
      if (this.conversationId && (!confirmed || sourceEpoch !== this.sourceEpoch))
        await this.reconcile();
      if (!submitted && !retry && !this.state.draft) this.set({ draft: content });
      this.abortController = null;
      this.set({ phase: "idle" });
      if (!this.retired) this.dependencies.changed();
    }
  }
}
