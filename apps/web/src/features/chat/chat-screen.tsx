"use client";

import { Button, buttonVariants } from "@solyn/ui/components/button";
import { Textarea } from "@solyn/ui/components/textarea";
import { cn } from "@solyn/ui/lib/utils";
import { ArrowLeft, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  startTransition,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import * as actions from "./actions";
import { confirmNoteProposal } from "../workspace/actions";
import {
  ChatSession,
  ChatSessions,
  messageStatus,
  shouldSend,
  type ProjectScope,
} from "./client-state";
import { CHAT_INPUT_LIMIT } from "./contracts";
import { MessageContent } from "./message-content";
import { ProposalPreview } from "./proposal-preview";
import { RetrievedNotes } from "./retrieved-notes";
import { useUnsavedChanges } from "../workspace/use-unsaved-changes";
import { issueMessages, type Issue } from "./transport";

type Initial = Awaited<ReturnType<typeof actions.getConversation>>;

function ChatHistory({ close }: { close: () => void }) {
  const [rows, setRows] = useState<
    Extract<Awaited<ReturnType<typeof actions.listConversations>>, { ok: true }>["data"]
  >([]);
  const [offset, setOffset] = useState(0);
  const [includeProjectChats, setIncludeProjectChats] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<Issue | null>(null);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    startTransition(async () => {
      try {
        const result = await actions.listConversations({
          limit: 20,
          offset,
          ...(includeProjectChats ? {} : { projectId: null }),
        });
        if (!active) return;
        if (result.ok) setRows(result.data);
        else setError(result.error.code);
      } catch {
        if (active) setError("UNAVAILABLE");
      } finally {
        if (active) setBusy(false);
      }
    });
    return () => {
      active = false;
    };
  }, [offset, includeProjectChats]);
  return (
    <nav
      className="chat-history absolute inset-[100%_16px_auto] rounded-[8px] border border-border bg-popover p-[12px]"
      aria-label="Conversation history"
      aria-busy={busy}
    >
      <label className="mb-[8px] flex min-h-[32px] items-center gap-[8px] text-[13px] [@media(pointer:coarse)]:min-h-[44px]">
        <input
          type="checkbox"
          checked={includeProjectChats}
          onChange={(event) => {
            setBusy(true);
            setRows([]);
            setOffset(0);
            setIncludeProjectChats(event.target.checked);
          }}
        />
        Include project chats
      </label>
      {busy ? (
        <p role="status">Loading conversations…</p>
      ) : error ? (
        <p role="alert">{issueMessages[error]}</p>
      ) : (
        <>
          {rows.length ? (
            <ul className="m-0 mb-[8px] max-h-[min(40dvh,320px)] list-none overflow-auto p-0">
              {rows.map((row) => (
                <li key={row.id}>
                  <Link
                    href={`/chat?conversationId=${row.id}`}
                    onClick={close}
                    className="grid gap-[2px] rounded-[6px] px-[10px] py-[8px] [overflow-wrap:anywhere] [&:hover]:bg-(--hover)"
                  >
                    <span>{row.title}</span>
                    <small className="text-[12px] text-muted-foreground">
                      {row.projectId ? "Project Chat" : "Main Chat"}
                    </small>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p>{includeProjectChats ? "No conversations yet." : "No Main Chat threads yet."}</p>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-[8px]">
        <Button
          className="control"
          variant="secondary"
          disabled={busy || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          Previous
        </Button>
        <Button
          className="control"
          variant="secondary"
          disabled={busy || !!error || rows.length < 20 || offset >= 99_980}
          onClick={() => setOffset(offset + 20)}
        >
          Next
        </Button>
        {error ? (
          <Button className="control" onClick={close}>
            Close history
          </Button>
        ) : null}
      </div>
    </nav>
  );
}

export default function ChatScreen({
  conversationId,
  project,
  initial,
  popup,
}: {
  conversationId?: string;
  project: ProjectScope;
  initial?: Initial;
  popup?: { open: boolean };
}) {
  const compact = !!popup;
  const popupOpen = popup?.open;
  const router = useRouter();
  const sessions = useRef(new ChatSessions());
  const activeSession = useRef<ChatSession | null>(null);
  const routeKey = conversationId
    ? `conversation:${conversationId}`
    : `new:${project?.id ?? "general"}`;
  function select() {
    return sessions.current.select(routeKey, () => {
      const session = new ChatSession(
        {
          create: actions.createConversation,
          confirm: confirmNoteProposal,
          recoverProposal: actions.getNoteProposal,
          read: compact
            ? async (input) => {
                const result = await actions.getConversation(input);
                if (
                  result.ok &&
                  (result.data.conversation.projectId !== project?.id ||
                    result.data.project?.id !== project?.id)
                )
                  return {
                    ok: false as const,
                    error: {
                      code: "UNAVAILABLE" as const,
                      message: "Project chat is unavailable.",
                    },
                  };
                return result;
              }
            : actions.getConversation,
          fetch: (...args) => fetch(...args),
          uuid: () => crypto.randomUUID(),
          created: (id) => {
            sessions.current.promote(routeKey, id, session);
            if (!compact && activeSession.current === session)
              startTransition(() =>
                router.replace(`/chat?conversationId=${id}`, { scroll: false }),
              );
          },
          changed: () => {
            if (activeSession.current === session) startTransition(() => router.refresh());
          },
        },
        { conversationId, project, initial },
      );
      return session;
    });
  }
  const [selection, setSelection] = useState(() => ({ key: routeKey, session: select() }));
  if (selection.key !== routeKey) setSelection({ key: routeKey, session: select() });
  const session = selection.session;
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const dirty = session.hasProposalChanges || (compact && !!state.draft);
  useUnsavedChanges(dirty);
  const previousSession = useRef(session);
  const wasDismissed = useRef(false);
  // Revoke on both dismissal and committed reopen: work finishing while hidden
  // may have refreshed sources before access changed again. Initial mount is
  // still read-only/Strict Mode safe; reopen never paints those cached links.
  useLayoutEffect(() => {
    if (popupOpen === false || wasDismissed.current) session.invalidateSources();
    wasDismissed.current = popupOpen === false;
  }, [session, popupOpen]);
  useEffect(() => {
    if (popupOpen === false) return;
    // Adopt a fresh authorized snapshot when returning to a cached conversation,
    // but never apply an older route response over an active/promoted stream.
    const switched = previousSession.current !== session;
    previousSession.current = session;
    // Cached route payloads are not a fresh authorization check. The layout
    // effect clears switched-session sources before paint; refresh via an action.
    if (session.getSnapshot().needsReconcile) void session.reload(false, false);
    else if (switched && initial) session.adopt(initial);
  }, [session, initial, popupOpen]);
  const messages = useRef<HTMLDivElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const pinned = useRef(true);
  const [history, setHistory] = useState(false);
  const historyToggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!history) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHistory(false);
        historyToggle.current?.focus();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [history]);
  useEffect(() => {
    setHistory(false);
  }, [session]);
  useLayoutEffect(() => {
    if (previousSession.current !== session) session.invalidateSources();
    activeSession.current = session;
    pinned.current = true;
    return () => {
      activeSession.current = null;
      session.stop();
    };
  }, [session]);
  useEffect(() => {
    const leave = () => {
      activeSession.current = null;
      session.stop();
    };
    const click = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
        return;
      const link =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download"))
        return;
      const destination = new URL(link.href);
      if (
        destination.origin !== window.location.origin ||
        destination.pathname !== window.location.pathname ||
        destination.search !== window.location.search
      )
        leave();
    };
    // The shared unsaved-changes capture guard stops propagation on cancellation.
    // Next Link itself prevents native default on accepted client navigation.
    document.addEventListener("click", click);
    window.addEventListener("popstate", leave);
    return () => {
      document.removeEventListener("click", click);
      window.removeEventListener("popstate", leave);
    };
  }, [session]);
  useEffect(() => {
    const scroll = () => {
      if (!compact && window.matchMedia("(max-width: 760px)").matches)
        pinned.current =
          window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 120;
    };
    window.addEventListener("scroll", scroll, { passive: true });
    return () => window.removeEventListener("scroll", scroll);
  }, [compact]);
  useLayoutEffect(() => {
    if (popupOpen === false || !pinned.current || !messages.current) return;
    if (compact || window.matchMedia("(min-width: 761px)").matches)
      messages.current.scrollTop = messages.current.scrollHeight;
    else if (!document.getElementById("workspace-sidebar")?.classList.contains("is-open"))
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  }, [state.messages, session, compact, popupOpen]);
  const busy = state.phase !== "idle";
  const canSend = session.canSend && !!state.draft.trim();
  const newHref = {
    pathname: "/chat",
    query: state.project ? { projectId: state.project.id } : {},
  };
  const generating = ["sending", "streaming", "creating", "stopping"].includes(state.phase);
  const lastMessage = state.messages.at(-1);
  const activeStatus = {
    idle:
      lastMessage?.role === "assistant"
        ? `Response: ${messageStatus(lastMessage, false).toLowerCase()}.`
        : "",
    creating: "Creating chat…",
    sending: "Sending…",
    streaming: "Generating…",
    stopping: "Stopping…",
    reloading: "Loading saved history…",
  }[state.phase];
  async function older() {
    const element = messages.current;
    if (!element) return;
    pinned.current = false;
    const desktop = compact || window.matchMedia("(min-width: 761px)").matches;
    const height = desktop ? element.scrollHeight : document.documentElement.scrollHeight;
    await session.reload(true);
    requestAnimationFrame(() => {
      if (desktop) element.scrollTop += element.scrollHeight - height;
      else window.scrollBy({ top: document.documentElement.scrollHeight - height });
    });
  }
  return (
    <section
      className="chat-screen flex h-full min-h-0 flex-col [@media(max-width:760px)]:h-auto [@media(max-width:760px)]:min-h-[calc(100dvh-88px)]"
      aria-label="Ask Solyn"
    >
      {!compact && (
        <header className="chat-header relative z-10 shrink-0 border-b border-border bg-canvas px-[24px] pt-[14px] pb-[12px] [@media(max-width:760px)]:px-[16px] [@media(max-width:760px)]:py-[14px]">
          <div className="chat-header-row flex items-center justify-between gap-[12px] [@media(max-width:760px)]:flex-wrap">
            <h1 className="min-w-0 truncate text-[16px] tracking-[-0.015em] [@media(max-width:760px)]:whitespace-normal">
              {state.conversation?.title ?? "Ask Solyn"}
            </h1>
            <div className="flex flex-wrap items-center gap-[8px]">
              <Button
                ref={historyToggle}
                type="button"
                className="control"
                variant="secondary"
                aria-expanded={history}
                aria-controls="chat-history"
                onClick={() => setHistory(!history)}
              >
                History
              </Button>
              <Link href={newHref} className={cn(buttonVariants(), "bg-clip-border select-auto")}>
                <Plus size={15} className="size-[15px]" aria-hidden="true" />
                New chat
              </Link>
            </div>
          </div>
          <div className="chat-scope mt-[4px] text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
            {state.project ? (
              <Link
                href={`/projects/${state.project.id}`}
                className="inline-flex items-center gap-[6px] text-[#b2c7ff]"
                aria-label={`Project Chat: ${state.project.name}. Back to project`}
              >
                <ArrowLeft size={14} aria-hidden="true" />
                Project Chat: {state.project.name}
              </Link>
            ) : (
              <span>
                {conversationId && !state.conversation
                  ? "Scope unavailable"
                  : "Main Chat · Search notes across your projects"}
              </span>
            )}
          </div>
          <div id="chat-history">
            {history ? <ChatHistory close={() => setHistory(false)} /> : null}
          </div>
        </header>
      )}
      <div
        className="chat-messages min-h-0 flex-1 overflow-auto p-[24px] [scrollbar-gutter:stable] [scroll-padding-block:20px] [@media(max-width:760px)]:overflow-visible [@media(max-width:760px)]:px-[16px] [@media(max-width:760px)]:py-[20px]"
        ref={messages}
        tabIndex={0}
        role="region"
        aria-label="Conversation messages"
        onScroll={(event) => {
          if (compact || window.matchMedia("(min-width: 761px)").matches) {
            const element = event.currentTarget;
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          }
        }}
      >
        <div className="chat-thread min-w-0 w-full">
          {state.hasOlder ? (
            <Button
              type="button"
              className="control"
              variant="secondary"
              disabled={busy}
              onClick={() => startTransition(older)}
            >
              Load older messages
            </Button>
          ) : null}
          {!state.messages.length && !state.needsReconcile ? (
            <p className="chat-empty py-[24px] text-muted-foreground">
              {state.conversation
                ? "No messages yet."
                : state.project
                  ? "Start a conversation."
                  : "Ask about notes across your projects. No project selection needed."}
            </p>
          ) : null}
          {state.messages.map((message) => (
            <article
              className={cn(
                `chat-message chat-message-${message.role}`,
                "mb-[28px] min-w-0 max-w-[760px] [overflow-wrap:anywhere]",
                message.role === "user" &&
                  "ml-auto w-fit max-w-[min(75%,760px)] [@media(max-width:760px)]:max-w-[92%] [&_.chat-prose]:rounded-[7px] [&_.chat-prose]:bg-(--hover) [&_.chat-prose]:px-[14px] [&_.chat-prose]:py-[10px]",
              )}
              key={`${message.turnId}:${message.role}`}
              aria-label={message.role === "user" ? "Your message" : "Solyn response"}
            >
              <header
                className={cn(
                  "mb-[8px] flex flex-wrap items-baseline gap-[12px] text-[13px] font-[550]",
                  message.role === "user" && "justify-end",
                )}
              >
                <span>{message.role === "user" ? "You" : "Solyn"}</span>
                <small className="text-[12px] font-normal text-muted-foreground">
                  {messageStatus(message, generating)}
                </small>
              </header>
              {message.content ? (
                <MessageContent content={message.content} />
              ) : (
                <p className="metadata">
                  {message.status === "pending"
                    ? generating
                      ? "Generating…"
                      : "Awaiting saved response."
                    : message.status === "stopped"
                      ? "Generation stopped."
                      : "No answer was saved."}
                </p>
              )}
              {previousSession.current === session ? <RetrievedNotes message={message} /> : null}
              {message.persisted && message.status === "completed" && message.proposal ? (
                <ProposalPreview
                  key={message.proposal.id}
                  proposal={message.proposal}
                  loadProjects={actions.listProposalProjects}
                  saveState={state.proposalSaves[message.proposal.id]}
                  save={() =>
                    startTransition(async () => session.confirmProposal(message.proposal!.id))
                  }
                  recover={() =>
                    startTransition(async () => session.recoverProposal(message.proposal!.id))
                  }
                  edit={state.proposalEdits[message.proposal.id]}
                  change={(patch) => session.editProposal(message.proposal!.id, patch)}
                />
              ) : null}
            </article>
          ))}
        </div>
      </div>
      <div className="chat-composer-area shrink-0 bg-canvas px-[24px] pt-[8px] pb-[16px] [@media(max-width:760px)]:sticky [@media(max-width:760px)]:bottom-0 [@media(max-width:760px)]:px-[16px] [@media(max-width:760px)]:pb-[max(16px,env(safe-area-inset-bottom))]">
        <div className="chat-composer-inner min-w-0 w-full">
          {state.issue ? (
            <div
              className="mt-[22px] rounded-[7px] border border-[#71404c] bg-[#342333] px-[16px] py-[14px] text-[14px] text-[#ffd2d7]"
              role="alert"
            >
              <p>{issueMessages[state.issue]}</p>
              {state.issue === "UNAUTHENTICATED" ? (
                <Link
                  href="/login"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-[8px] inline-block underline"
                >
                  Sign in in a new tab
                </Link>
              ) : null}
            </div>
          ) : null}
          {state.viewingOlder ? (
            <p className="chat-notice mb-[8px] text-[13px] text-muted-foreground">
              Viewing older messages. Reload saved history to return to the latest messages and
              continue.
            </p>
          ) : null}
          {state.pendingTurn ? (
            <p className="chat-notice mb-[8px] text-[13px] text-muted-foreground" role="status">
              {state.pendingTurn.abandoned
                ? "The previous response was interrupted. Sending a new message will mark it failed."
                : "A response is still pending. Reload saved history to check its status."}
            </p>
          ) : null}
          {state.attempt && !busy && !state.pendingTurn ? (
            <p className="chat-notice mb-[8px] text-[13px] text-muted-foreground">
              This send is not confirmed. Reload history or retry the same message with its original
              turn ID.
            </p>
          ) : null}
          <div className="chat-recovery mb-[8px] flex flex-wrap items-center gap-[8px] empty:hidden">
            {conversationId || state.conversation ? (
              <Button
                type="button"
                className="control"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  if (
                    session.hasProposalChanges &&
                    !window.confirm(
                      "Reload the original drafts? Your local note edits will be lost.",
                    )
                  )
                    return;
                  pinned.current = true;
                  startTransition(async () => session.reload());
                }}
              >
                {compact ? "Reload messages" : "Reload saved history"}
              </Button>
            ) : null}
            {session.canRetry ? (
              <Button
                type="button"
                className="control"
                variant="secondary"
                onClick={() => startTransition(async () => session.submit(true))}
              >
                Retry same message
              </Button>
            ) : null}
          </div>
          <form
            ref={form}
            data-unsaved={dirty ? "true" : "false"}
            className="chat-composer rounded-[8px] border border-input bg-secondary p-[10px] focus-within:border-ring"
            onSubmit={(event) => {
              event.preventDefault();
              startTransition(async () => session.submit());
            }}
          >
            <label htmlFor="chat-input" className="sr-only">
              Message Solyn
            </label>
            <Textarea
              id="chat-input"
              className="chat-input h-[96px] min-h-[72px] max-h-[min(24dvh,180px)] field-sizing-fixed resize-none overflow-y-auto rounded-[4px] border-0 bg-transparent px-[4px] py-[2px] text-[15px] leading-[1.6] [@media(max-width:760px)]:min-h-[72px] [@media(max-width:760px)]:text-[16px] [@media(pointer:coarse)]:min-h-[72px]"
              rows={compact ? 2 : 3}
              maxLength={CHAT_INPUT_LIMIT}
              value={state.draft}
              placeholder="Message Solyn…"
              aria-describedby="chat-input-help"
              onChange={(event) => session.setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (canSend && shouldSend(event.nativeEvent)) {
                  event.preventDefault();
                  form.current?.requestSubmit();
                }
              }}
            />
            <div className="chat-composer-toolbar mt-[6px] flex items-center gap-[10px]">
              <span
                role="status"
                aria-live="polite"
                className="flex-1 text-[12px] text-muted-foreground"
              >
                {activeStatus}
              </span>
              <span
                className="metadata"
                aria-label={`${state.draft.length} of ${CHAT_INPUT_LIMIT} characters`}
              >
                {state.draft.length}/{CHAT_INPUT_LIMIT}
              </span>
              {generating ? (
                <Button
                  type="button"
                  className="control"
                  variant="secondary"
                  disabled={state.phase === "stopping"}
                  onClick={() => session.stop()}
                >
                  Stop generation
                </Button>
              ) : (
                <Button type="submit" className="control" disabled={!canSend}>
                  Send
                </Button>
              )}
            </div>
          </form>
          <p className="chat-help mt-[8px] text-[12px] text-muted-foreground" id="chat-input-help">
            {compact
              ? "Drafts stay here. Replies continue when closed."
              : "Enter to send · Shift+Enter for a new line. Ask to prepare a note draft, then review and explicitly save it. Search covers authorized notes in this chat’s scope."}
          </p>
        </div>
      </div>
    </section>
  );
}
