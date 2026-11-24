"use client";

import { Button } from "@solyn/ui/components/button";
import { FolderClosed, House, Menu, MessageSquare, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import SignOutButton from "./sign-out-button";

export function Wordmark() {
  return (
    <span
      className="wordmark text-[30px] leading-none font-[650] tracking-[-0.065em] [.mobile-header_&]:text-[27px]"
      translate="no"
    >
      solyn<span className="text-[#4f7cff]">.</span>
    </span>
  );
}

export default function WorkspaceShell({
  name,
  email,
  recentConversations = [],
  children,
}: {
  name: string;
  email: string;
  recentConversations?: { id: string; title: string; projectId: string | null }[];
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggle.current?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);
  return (
    <div className="workspace-shell min-h-screen">
      <a
        className="skip-link fixed top-[10px] left-[15px] z-[100] -translate-y-[160%] rounded-[5px] bg-[#eff4ff] px-[16px] py-[10px] text-[#080f20] focus:translate-y-0"
        href="#workspace-main"
      >
        Skip to content
      </a>
      <header className="mobile-header glass hidden border border-border [@media(max-width:760px)]:sticky [@media(max-width:760px)]:top-0 [@media(max-width:760px)]:z-30 [@media(max-width:760px)]:flex [@media(max-width:760px)]:items-center [@media(max-width:760px)]:justify-between [@media(max-width:760px)]:[border-width:0_0_1px] [@media(max-width:760px)]:[padding:max(16px,env(safe-area-inset-top))_max(20px,env(safe-area-inset-right))_16px_max(20px,env(safe-area-inset-left))]">
        <Link href="/dashboard" aria-label="Solyn workspace">
          <Wordmark />
        </Link>
        <Button
          ref={toggle}
          type="button"
          variant="ghost"
          className="control"
          aria-controls="workspace-sidebar"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}{" "}
          {open ? "Close menu" : "Menu"}
        </Button>
      </header>
      <aside
        id="workspace-sidebar"
        className={`sidebar glass fixed top-[16px] bottom-[16px] left-[16px] z-20 flex w-[248px] flex-col overflow-y-auto rounded-[12px] border border-border px-[12px] pt-[24px] pb-[12px] [@media(max-width:760px)]:static [@media(max-width:760px)]:mx-[16px] [@media(max-width:760px)]:mt-[12px] [@media(max-width:760px)]:hidden [@media(max-width:760px)]:max-h-[calc(100svh-100px)] [@media(max-width:760px)]:w-auto [@media(max-width:760px)]:[&.is-open]:flex ${open ? "is-open" : ""}`}
      >
        <Link
          className="sidebar-brand inline-flex w-fit px-[10px] [@media(max-width:760px)]:hidden"
          href="/dashboard"
          aria-label="Solyn workspace"
          onClick={() => setOpen(false)}
        >
          <Wordmark />
        </Link>
        <p className="sidebar-caption mx-[10px] mt-[16px] mb-[24px] text-[12px] text-muted-foreground [@media(max-width:760px)]:mx-[12px] [@media(max-width:760px)]:mt-0 [@media(max-width:760px)]:mb-[18px]">
          Personal workspace
        </p>
        <nav
          className="grid gap-[3px]"
          aria-label="Workspace"
          onClick={(event) => {
            if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
          }}
        >
          <Link
            className="nav-item flex min-h-[36px] items-center gap-[12px] rounded-[7px] px-[12px] py-[7px] text-[14px] text-muted-foreground aria-[current=page]:bg-(--selected) aria-[current=page]:text-foreground aria-[current=page]:shadow-[inset_2px_0_var(--brand)] [&:hover:not([aria-current=page])]:bg-(--hover) [&:hover:not([aria-current=page])]:text-foreground [@media(max-width:760px)]:min-h-[44px] [@media(pointer:coarse)]:min-h-[44px]"
            href="/dashboard"
            aria-current={pathname === "/dashboard" ? "page" : undefined}
          >
            <House size={17} aria-hidden="true" />
            Workspace
          </Link>
          <Link
            className="nav-item flex min-h-[36px] items-center gap-[12px] rounded-[7px] px-[12px] py-[7px] text-[14px] text-muted-foreground aria-[current=page]:bg-(--selected) aria-[current=page]:text-foreground aria-[current=page]:shadow-[inset_2px_0_var(--brand)] [&:hover:not([aria-current=page])]:bg-(--hover) [&:hover:not([aria-current=page])]:text-foreground [@media(max-width:760px)]:min-h-[44px] [@media(pointer:coarse)]:min-h-[44px]"
            href="/projects"
            aria-current={pathname.startsWith("/projects") ? "page" : undefined}
          >
            <FolderClosed size={17} aria-hidden="true" />
            Projects
          </Link>
          <Link
            className="nav-item flex min-h-[36px] items-center gap-[12px] rounded-[7px] px-[12px] py-[7px] text-[14px] text-muted-foreground aria-[current=page]:bg-(--selected) aria-[current=page]:text-foreground aria-[current=page]:shadow-[inset_2px_0_var(--brand)] [&:hover:not([aria-current=page])]:bg-(--hover) [&:hover:not([aria-current=page])]:text-foreground [@media(max-width:760px)]:min-h-[44px] [@media(pointer:coarse)]:min-h-[44px]"
            href="/chat"
            title="Main Chat — search notes across your projects"
            aria-current={pathname === "/chat" ? "page" : undefined}
          >
            <MessageSquare size={17} aria-hidden="true" />
            Ask Solyn
          </Link>
        </nav>
        {recentConversations.length ? (
          <nav
            className="recent-conversations mt-[20px] grid gap-[3px]"
            aria-label="Recent Main Chat threads"
            onClick={(event) => {
              if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
            }}
          >
            <p className="mx-[12px] mb-[4px] text-[12px] text-muted-foreground">
              Recent Main Chat threads
            </p>
            {recentConversations.map((conversation) => (
              <Link
                className="nav-item grid min-h-[42px] items-center gap-px rounded-[7px] px-[12px] py-[7px] text-[13px] text-muted-foreground [&:hover]:bg-(--hover) [&:hover]:text-foreground [@media(max-width:760px)]:min-h-[44px]"
                key={conversation.id}
                href={`/chat?conversationId=${conversation.id}`}
              >
                <span className="truncate">{conversation.title}</span>
                <small className="text-[11px] text-muted-foreground">
                  {conversation.projectId ? "Project Chat" : "Main Chat"}
                </small>
              </Link>
            ))}
          </nav>
        ) : null}
        <div className="sidebar-bottom mt-auto pt-[32px] [@media(max-width:760px)]:pt-[20px]">
          <div className="account flex min-w-0 items-center gap-[10px] border-t border-border px-[8px] py-[16px]">
            <span
              className="avatar grid size-[32px] shrink-0 place-items-center rounded-full bg-button text-[13px] text-foreground"
              aria-hidden="true"
            >
              {name.trim().slice(0, 1).toUpperCase() || "S"}
            </span>
            <div className="min-w-0">
              <p className="text-[13px] [overflow-wrap:anywhere]">{name || "Your account"}</p>
              <span className="block text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
                {email}
              </span>
            </div>
          </div>
          <SignOutButton />
        </div>
      </aside>
      <main
        id="workspace-main"
        className={`workspace-main m-[16px_16px_16px_280px] min-h-[calc(100vh-32px)] min-w-0 rounded-[12px] border border-border bg-canvas [@media(min-width:761px)]:fixed [@media(min-width:761px)]:inset-[16px_16px_16px_280px] [@media(min-width:761px)]:m-0 [@media(min-width:761px)]:min-h-0 [@media(min-width:761px)]:overflow-auto [@media(min-width:761px)]:[scrollbar-gutter:stable] [@media(min-width:761px)]:[scroll-padding-block:8rem_24px] [@media(max-width:760px)]:m-[12px_0_0] [@media(max-width:760px)]:min-h-[calc(100svh-88px)] [@media(max-width:760px)]:rounded-[10px_10px_0_0] [@media(max-width:760px)]:[border-width:1px_0_0] ${pathname === "/chat" ? " is-chat" : ""}`}
        tabIndex={0}
        aria-label="Workspace"
      >
        {children}
      </main>
    </div>
  );
}
