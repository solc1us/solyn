"use client";

import { Button } from "@solyn/ui/components/button";
import { Textarea } from "@solyn/ui/components/textarea";
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
import {
  ChatSession,
  ChatSessions,
  messageStatus,
  shouldSend,
  type ProjectScope,
} from "./client-state";
import { CHAT_INPUT_LIMIT } from "./contracts";
import { MessageContent } from "./message-content";
import { issueMessages, type Issue } from "./transport";

type Initial = Awaited<ReturnType<typeof actions.getConversation>>;

function ChatHistory({ close }: { close: () => void }) {
  const [rows, setRows] = useState<
    Extract<Awaited<ReturnType<typeof actions.listConversations>>, { ok: true }>["data"]
  >([]);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<Issue | null>(null);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError(null);
    startTransition(async () => {
      try {
        const result = await actions.listConversations({ limit: 20, offset });
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
  }, [offset]);
  return (
    <nav className="chat-history" aria-label="Conversation history" aria-busy={busy}>
      {busy ? (
        <p role="status">Loading conversations…</p>
      ) : error ? (
        <p role="alert">{issueMessages[error]}</p>
      ) : (
        <>
          {rows.length ? (
            <ul>
              {rows.map((row) => (
                <li key={row.id}>
                  <Link href={`/chat?conversationId=${row.id}`} onClick={close}>
                    <span>{row.title}</span>
                    <small>{row.projectId ? "Project chat" : "General chat"}</small>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p>No conversations yet.</p>
          )}
        </>
      )}
      <div className="inline-actions">
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
}: {
  conversationId?: string;
  project: ProjectScope;
  initial?: Initial;
}) {
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
          read: actions.getConversation,
          fetch: (...args) => fetch(...args),
          uuid: () => crypto.randomUUID(),
          created: (id) => {
            sessions.current.promote(routeKey, id, session);
            if (activeSession.current === session)
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
  const previousSession = useRef(session);
  useEffect(() => {
    // Adopt a fresh authorized snapshot when returning to a cached conversation,
    // but never apply an older route response over an active/promoted stream.
    if (previousSession.current === session) return;
    previousSession.current = session;
    if (initial) session.adopt(initial);
  }, [session, initial]);
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
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
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
    document.addEventListener("click", click, true);
    window.addEventListener("popstate", leave);
    return () => {
      document.removeEventListener("click", click, true);
      window.removeEventListener("popstate", leave);
    };
  }, [session]);
  useEffect(() => {
    const scroll = () => {
      if (window.matchMedia("(max-width: 760px)").matches)
        pinned.current =
          window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 120;
    };
    window.addEventListener("scroll", scroll, { passive: true });
    return () => window.removeEventListener("scroll", scroll);
  }, []);
  useLayoutEffect(() => {
    if (!pinned.current || !messages.current) return;
    if (window.matchMedia("(min-width: 761px)").matches)
      messages.current.scrollTop = messages.current.scrollHeight;
    else if (!document.getElementById("workspace-sidebar")?.classList.contains("is-open"))
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
  }, [state.messages, session]);
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
    const desktop = window.matchMedia("(min-width: 761px)").matches;
    const height = desktop ? element.scrollHeight : document.documentElement.scrollHeight;
    await session.reload(true);
    requestAnimationFrame(() => {
      if (desktop) element.scrollTop += element.scrollHeight - height;
      else window.scrollBy({ top: document.documentElement.scrollHeight - height });
    });
  }
  return (
    <section className="chat-screen" aria-label="Ask Solyn">
      <header className="chat-header">
        <div className="chat-header-row">
          <h1>{state.conversation?.title ?? "Ask Solyn"}</h1>
          <div className="inline-actions">
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
            <Link href={newHref} className="secondary-link">
              <Plus size={15} aria-hidden="true" />
              New chat
            </Link>
          </div>
        </div>
        <div className="chat-scope">
          {state.project ? (
            <Link
              href={`/projects/${state.project.id}`}
              aria-label={`Project: ${state.project.name}. Back to project`}
            >
              <ArrowLeft size={14} aria-hidden="true" />
              Project: {state.project.name}
            </Link>
          ) : (
            <span>
              {conversationId && !state.conversation ? "Scope unavailable" : "General chat"}
            </span>
          )}
        </div>
        <div id="chat-history">
          {history ? <ChatHistory close={() => setHistory(false)} /> : null}
        </div>
      </header>
      <div
        className="chat-messages"
        ref={messages}
        tabIndex={0}
        role="region"
        aria-label="Conversation messages"
        onScroll={(event) => {
          if (window.matchMedia("(min-width: 761px)").matches) {
            const element = event.currentTarget;
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          }
        }}
      >
        <div className="chat-thread">
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
            <p className="chat-empty">
              {state.conversation ? "No messages yet." : "Start a conversation."}
            </p>
          ) : null}
          {state.messages.map((message) => (
            <article
              className={`chat-message chat-message-${message.role}`}
              key={`${message.turnId}:${message.role}`}
              aria-label={message.role === "user" ? "Your message" : "Solyn response"}
            >
              <header>
                <span>{message.role === "user" ? "You" : "Solyn"}</span>
                <small>{messageStatus(message, generating)}</small>
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
            </article>
          ))}
        </div>
      </div>
      <div className="chat-composer-area">
        <div className="chat-composer-inner">
          {state.issue ? (
            <div className="feedback feedback-error" role="alert">
              <p>{issueMessages[state.issue]}</p>
              {state.issue === "UNAUTHENTICATED" ? (
                <Link href="/login" target="_blank" rel="noopener noreferrer">
                  Sign in in a new tab
                </Link>
              ) : null}
            </div>
          ) : null}
          {state.viewingOlder ? (
            <p className="chat-notice">
              Viewing older messages. Reload saved history to return to the latest messages and
              continue.
            </p>
          ) : null}
          {state.pendingTurn ? (
            <p className="chat-notice" role="status">
              {state.pendingTurn.abandoned
                ? "The previous response was interrupted. Sending a new message will mark it failed."
                : "A response is still pending. Reload saved history to check its status."}
            </p>
          ) : null}
          {state.attempt && !busy && !state.pendingTurn ? (
            <p className="chat-notice">
              This send is not confirmed. Reload history or retry the same message with its original
              turn ID.
            </p>
          ) : null}
          <div className="chat-recovery inline-actions">
            {conversationId || state.conversation ? (
              <Button
                type="button"
                className="control"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  pinned.current = true;
                  startTransition(async () => session.reload());
                }}
              >
                Reload saved history
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
            className="chat-composer"
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
              className="chat-input"
              rows={3}
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
            <div className="chat-composer-toolbar">
              <span role="status" aria-live="polite">
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
          <p className="chat-help" id="chat-input-help">
            Enter to send · Shift+Enter for a new line. Project notes aren’t available in chat yet.
          </p>
        </div>
      </div>
    </section>
  );
}
