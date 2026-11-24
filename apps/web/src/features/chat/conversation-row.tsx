"use client";

import { Button } from "@solyn/ui/components/button";
import { Input } from "@solyn/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@solyn/ui/components/dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { startTransition, useEffect, useId, useRef, useState } from "react";

import type { deleteConversation, renameConversation } from "./actions";
import { renameConversationInput, type ErrorCode } from "./contracts";

export type ConversationRowData = { id: string; title: string; projectId: string | null };
export type ConversationChange = { id: string; title: string } | { id: string; deleted: true };
export const CONVERSATION_CHANGED = "solyn:conversation-changed";

// View-local acknowledgements survive an older RSC/history result. No account,
// browser-storage cache or data-access authority is introduced by this event.
export function useConversationRows(rows: ConversationRowData[]) {
  const [changes, setChanges] = useState<Record<string, string | null>>({});
  useEffect(() => {
    const changed = (event: Event) => {
      const change = (event as CustomEvent<ConversationChange>).detail;
      setChanges((current) =>
        current[change.id] === null
          ? current
          : {
              ...current,
              [change.id]: "deleted" in change ? null : change.title,
            },
      );
    };
    window.addEventListener(CONVERSATION_CHANGED, changed);
    return () => window.removeEventListener(CONVERSATION_CHANGED, changed);
  }, []);
  return rows
    .filter((row) => changes[row.id] !== null)
    .map((row) => ({ ...row, title: changes[row.id] ?? row.title }));
}

const changeError = (code: ErrorCode) =>
  ({
    UNAUTHENTICATED: "Sign in again before changing this chat.",
    NOT_FOUND: "This chat is unavailable. Reload history.",
    INVALID_INPUT: "Enter a title of up to 300 characters.",
    CONFLICT: "This chat has pending work. Stop or resolve the reply before deleting it.",
    UNAVAILABLE: "This change could not be confirmed. Reload history before trying again.",
  })[code];

export function ConversationRow({
  conversation,
  rename,
  remove,
  changed,
  close,
  showScope = false,
}: {
  conversation: ConversationRowData;
  rename: typeof renameConversation;
  remove: typeof deleteConversation;
  changed: () => void;
  close?: () => void;
  showScope?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (editing) {
      field.current?.focus();
      field.current?.select();
    }
  }, [editing]);
  function acknowledge(change: ConversationChange) {
    window.dispatchEvent(new CustomEvent(CONVERSATION_CHANGED, { detail: change }));
    changed();
  }
  async function saveTitle() {
    if (pending.current) return;
    const parsed = renameConversationInput.safeParse({ conversationId: conversation.id, title });
    if (!parsed.success) {
      setError("Please enter a title of up to 300 characters.");
      field.current?.focus();
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await rename(parsed.data);
      if (result.ok) {
        if (mounted.current) setEditing(false);
        acknowledge({ id: result.data.id, title: result.data.title });
        trigger.current?.focus();
      } else if (mounted.current) setError(changeError(result.error.code));
    } catch {
      if (mounted.current) setError(changeError("UNAVAILABLE"));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function erase() {
    if (pending.current) return;
    if (
      !window.confirm(
        `Permanently delete “${conversation.title}”?\n\nChat history and related drafts/proposals will be permanently deleted, including local chat edits. Already-saved project notes and their revision history will be kept.\n\nThis cannot be undone.`,
      )
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await remove({ conversationId: conversation.id });
      // Revalidation may unmount the deleted row before this acknowledgement.
      // Still retire its cached/active session and invalidate other visible lists.
      if (result.ok) acknowledge({ id: result.data.id, deleted: true });
      else if (mounted.current) setError(changeError(result.error.code));
    } catch {
      if (mounted.current) setError(changeError("UNAVAILABLE"));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div
      className="conversation-row min-w-0 rounded-[7px] text-[13px] text-muted-foreground hover:bg-(--hover)"
      aria-busy={busy}
    >
      <div className="flex min-w-0 items-center">
        <Link
          className="nav-item grid min-h-[42px] min-w-0 flex-1 gap-px px-[12px] py-[7px] hover:text-foreground [@media(max-width:760px)]:min-h-[44px]"
          href={`/chat?conversationId=${conversation.id}`}
          onClick={close}
          title={conversation.title}
        >
          <span className="truncate">{conversation.title}</span>
          {showScope ? (
            <small className="text-[12px] text-muted-foreground">
              {conversation.projectId ? "Project Chat" : "Main Chat"}
            </small>
          ) : null}
        </Link>
        {conversation.projectId === null ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              ref={trigger}
              disabled={busy}
              aria-label={`Manage chat: ${conversation.title}`}
              className="mr-[4px] grid size-[32px] shrink-0 place-items-center rounded-[5px] text-muted-foreground hover:bg-(--selected) hover:text-foreground [@media(pointer:coarse)]:size-[44px]"
            >
              <MoreHorizontal size={17} aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="min-w-[140px] rounded-[7px] border border-border p-[4px]"
              finalFocus={() => field.current ?? trigger.current}
            >
              <DropdownMenuItem
                className="rounded-[5px] text-[13px]"
                onClick={() => {
                  setTitle(conversation.title);
                  setError(null);
                  setEditing(true);
                }}
              >
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                className="rounded-[5px] text-[13px]"
                variant="destructive"
                onClick={() => startTransition(erase)}
              >
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {editing ? (
        <form
          className="grid gap-[8px] px-[8px] pb-[8px]"
          noValidate
          aria-label="Rename chat"
          onSubmit={(event) => {
            event.preventDefault();
            startTransition(saveTitle);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !pending.current) {
              event.stopPropagation();
              setEditing(false);
              setError(null);
              trigger.current?.focus();
            }
          }}
        >
          <label htmlFor={id} className="sr-only">
            Thread title
          </label>
          <Input
            ref={field}
            id={id}
            className="form-control"
            maxLength={300}
            value={title}
            disabled={busy}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => {
              setTitle(event.target.value);
              setError(null);
            }}
          />
          <div className="flex gap-[8px]">
            <Button type="submit" className="control" disabled={busy}>
              {busy ? "Saving…" : "Save title"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="control"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(null);
                trigger.current?.focus();
              }}
            >
              Cancel rename
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="px-[10px] pb-[8px] text-[13px] text-destructive"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
