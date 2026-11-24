"use client";

import { Button } from "@solyn/ui/components/button";
import { MessageCircle, X } from "lucide-react";
import { startTransition, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { getConversation, listConversations } from "./actions";
import ChatScreen from "./chat-screen";

type Project = { id: string; name: string };
type Initial = Awaited<ReturnType<typeof getConversation>>;
type Loaded =
  | { state: "idle" | "loading" | "error" }
  | { state: "ready"; conversationId?: string; initial?: Initial };

// A project change must unmount its session, not reuse it as another scope.
export default function ProjectChatPopup({ project }: { project: Project }) {
  return <ProjectPopup key={project.id} project={project} />;
}

function ProjectPopup({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ state: "idle" });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const alive = useRef(false);
  const loading = useRef(false);
  const id = useId();
  const ready = loaded.state === "ready";

  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const element = panel.current;
    if (!element) return;
    // Non-modal: do not trap focus, inert the project page, or lock its scroll.
    element.focus({ preventScroll: true });
    const viewport = window.visualViewport;
    const resize = () => {
      const height = viewport?.height ?? window.innerHeight;
      const keyboard = Math.max(0, window.innerHeight - height - (viewport?.offsetTop ?? 0));
      element.style.setProperty("--project-chat-viewport-height", `${height}px`);
      element.style.setProperty("--project-chat-keyboard-offset", `${keyboard}px`);
    };
    resize();
    window.addEventListener("resize", resize);
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    return () => {
      window.removeEventListener("resize", resize);
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
    };
  }, [open]);

  useLayoutEffect(() => {
    // Do not steal focus back if the user moved into the project during loading.
    if (open && ready && panel.current?.contains(document.activeElement))
      panel.current.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
  }, [open, ready]);

  function close() {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  function resume() {
    if (loading.current) return;
    loading.current = true;
    setLoaded({ state: "loading" });
    startTransition(async () => {
      try {
        // One bounded owner/project-scoped DB lookup; never scan general history.
        const latest = await listConversations({ projectId: project.id, limit: 1, offset: 0 });
        if (!latest.ok) throw new Error("Unavailable");
        const conversation = latest.data[0];
        let next: Loaded = { state: "ready" };
        if (conversation) {
          if (conversation.projectId !== project.id) throw new Error("Invalid scope");
          const initial = await getConversation({
            conversationId: conversation.id,
            latest: true,
            limit: 50,
          });
          if (
            !initial.ok ||
            initial.data.conversation.id !== conversation.id ||
            initial.data.conversation.projectId !== project.id ||
            initial.data.project?.id !== project.id
          )
            throw new Error("Unavailable");
          next = { state: "ready", conversationId: conversation.id, initial };
        }
        if (alive.current) setLoaded(next);
      } catch {
        // No fallback to general chat, new conversation, or inaccessible metadata.
        if (alive.current) setLoaded({ state: "error" });
      } finally {
        loading.current = false;
      }
    });
  }

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        aria-label={`Ask Solyn about ${project.name}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            if (loaded.state === "idle") resume();
          }
        }}
      >
        <MessageCircle size={15} aria-hidden="true" />
        Ask Solyn
      </Button>
      {loaded.state !== "idle"
        ? createPortal(
            // Keep ChatScreen mounted across dismissal. Hidden + inert removes all
            // controls from keyboard/accessibility navigation without losing drafts.
            <div hidden={!open} inert={!open} style={!open ? { display: "none" } : undefined}>
              <section
                id={id}
                ref={panel}
                role="dialog"
                aria-modal="false"
                aria-labelledby={`${id}-title`}
                aria-describedby={`${id}-project`}
                tabIndex={-1}
                className="project-chat-panel fixed right-[max(28px,env(safe-area-inset-right))] bottom-[calc(max(var(--project-chat-inset),env(safe-area-inset-bottom))_+_var(--project-chat-keyboard-offset,0px))] z-40 flex h-[min(640px,calc(var(--project-chat-viewport-height,100dvh)_-_max(var(--project-chat-inset),env(safe-area-inset-top))_-_max(var(--project-chat-inset),env(safe-area-inset-bottom))))] w-[440px] max-w-[calc(100vw-56px)] flex-col overflow-hidden rounded-[12px] border border-border bg-canvas shadow-[0_20px_64px_#0006,0_4px_16px_#0004] outline-none [--project-chat-inset:28px] [@media(max-width:760px)]:[--project-chat-inset:16px] [@media(max-width:760px)]:right-[max(8px,env(safe-area-inset-right))] [@media(max-width:760px)]:left-[max(8px,env(safe-area-inset-left))] [@media(max-width:760px)]:w-auto [@media(max-width:760px)]:max-w-none [&_.chat-screen]:h-full [&_.chat-screen]:min-h-0 [&_.chat-messages]:overflow-auto [&_.chat-messages]:p-[16px] [&_.chat-composer-area]:static [&_.chat-composer-area]:max-h-full [&_.chat-composer-area]:overflow-auto [&_.chat-composer-area]:px-[12px] [&_.chat-composer-area]:pb-[12px] [&_.chat-input]:h-[64px] [&_.chat-input]:min-h-[44px] [&_.chat-input]:max-h-[80px] [&_.chat-input]:resize-none"
                onKeyDown={(event) => {
                  if (
                    event.key !== "Escape" ||
                    event.defaultPrevented ||
                    event.nativeEvent.isComposing
                  )
                    return;
                  // Let a native select/combobox handle its own Escape first.
                  if (
                    event.target instanceof Element &&
                    event.target.closest("select, [role=combobox]")
                  )
                    return;
                  event.stopPropagation();
                  event.preventDefault();
                  close();
                }}
              >
                <header className="flex shrink-0 items-center justify-between gap-[12px] border-b border-border px-[16px] py-[10px]">
                  <div className="min-w-0">
                    <h2 id={`${id}-title`} className="text-[14px] font-medium">
                      Solyn
                    </h2>
                    <p id={`${id}-project`} className="truncate text-[12px] text-muted-foreground">
                      Project: {project.name}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label="Close project chat"
                    onClick={close}
                  >
                    <X size={16} aria-hidden="true" />
                  </Button>
                </header>
                {loaded.state === "ready" ? (
                  <ChatScreen
                    conversationId={loaded.conversationId}
                    project={project}
                    initial={loaded.initial}
                    popup={{ open }}
                  />
                ) : (
                  <div className="min-h-0 overflow-auto p-[16px] text-[14px]">
                    {loaded.state === "error" ? (
                      <>
                        <p role="alert">
                          Project chat is unavailable. Check your connection and try again.
                        </p>
                        <Button
                          type="button"
                          variant="secondary"
                          className="mt-[12px]"
                          onClick={resume}
                        >
                          Retry loading chat
                        </Button>
                      </>
                    ) : (
                      <p role="status">Loading project chat…</p>
                    )}
                  </div>
                )}
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
