"use client";

import { Button } from "@solyn/ui/components/button";
import { Input } from "@solyn/ui/components/input";
import { Label } from "@solyn/ui/components/label";
import Link from "next/link";
import {
  startTransition,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { createNoteSearch, type NoteSearchState, type SearchAction } from "./note-search-state";
import { formatDate } from "./presentation";

export default function NoteSearch({
  projectId,
  searchAction,
  children,
}: {
  projectId: string;
  searchAction: SearchAction;
  children: ReactNode;
}) {
  const [search] = useState(() => createNoteSearch(projectId, searchAction));
  const state = useSyncExternalStore(search.subscribe, search.getSnapshot, search.getSnapshot);
  const [input, setInput] = useState("");
  const fieldId = useId();
  const field = useRef<HTMLInputElement>(null);
  return (
    <>
      <form
        role="search"
        aria-label="Search project notes"
        className="mb-[12px]"
        onSubmit={(event) => {
          event.preventDefault();
          setInput(input.trim());
          startTransition(() => search.submit(input));
        }}
      >
        <Label htmlFor={fieldId} className="mb-[8px]">
          Search notes
        </Label>
        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-[8px] [@media(max-width:760px)]:grid-cols-2">
          <Input
            ref={field}
            id={fieldId}
            name="query"
            type="search"
            maxLength={200}
            value={input}
            className="min-w-0 [@media(max-width:760px)]:col-span-2"
            onChange={(event) => {
              setInput(event.target.value);
              if (!event.target.value.trim()) search.clear();
            }}
          />
          <Button type="submit" disabled={state.pending && input.trim() === state.query}>
            Search
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!input && state.query === null}
            onClick={() => {
              setInput("");
              search.clear();
              field.current?.focus();
            }}
          >
            Clear
          </Button>
        </div>
      </form>
      <div hidden={state.query !== null}>{children}</div>
      <NoteSearchResults
        projectId={projectId}
        state={state}
        loadMore={() => startTransition(() => search.loadMore())}
      />
    </>
  );
}

export function NoteSearchResults({
  projectId,
  state,
  loadMore,
}: {
  projectId: string;
  state: NoteSearchState;
  loadMore: () => void;
}) {
  if (state.query === null) return null;
  const error =
    state.error === "UNAUTHENTICATED"
      ? "Your session has ended."
      : state.error === "NOT_FOUND"
        ? "This project is no longer available, or you do not have access to it."
        : state.error === "INVALID_INPUT"
          ? "Enter a search query of 1–200 valid text characters."
          : state.offset > 0
            ? "Could not load more results. Your current results are unchanged."
            : "Could not search notes. Try Search again.";
  return (
    <>
      <p
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="px-[12px] py-[8px] text-[12px] text-muted-foreground [overflow-wrap:anywhere]"
      >
        {state.pending
          ? state.offset > 0
            ? "Loading more results…"
            : "Searching notes…"
          : state.error
            ? ""
            : `${state.rows.length} ${state.rows.length === 1 ? "result" : "results"} loaded for “${state.query}”.`}
      </p>
      <section aria-label="Note search results" aria-busy={state.pending}>
        {state.error ? (
          <div role="alert" className="px-[12px] py-[16px] text-destructive">
            <p>{error}</p>
            {state.error === "UNAUTHENTICATED" ? (
              <Link href="/login" className="underline">
                Sign in
              </Link>
            ) : null}
          </div>
        ) : null}
        <ul className="m-0 list-none p-0">
          {state.rows.map((note) => (
            <li key={note.id}>
              <Link
                href={`/projects/${projectId}/notes/${note.id}`}
                prefetch={false}
                className="collection-row block rounded-[7px] px-[12px] py-[10px] hover:bg-(--hover) [@media(max-width:760px)]:px-[8px]"
              >
                <span className="block text-[14px] font-[550] [overflow-wrap:anywhere]">
                  {note.title}
                </span>
                <p className="mt-[4px] line-clamp-3 text-[13px] leading-[1.6] whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                  {note.excerpt}
                </p>
                <div className="mt-[4px] flex flex-wrap gap-x-[16px] gap-y-[2px] text-[12px] text-muted-foreground">
                  {note.noteDate ? <span>Note date: {formatDate(note.noteDate)}</span> : null}
                  <time dateTime={new Date(note.updatedAt).toISOString()}>
                    Last edited {formatDate(note.updatedAt)}
                  </time>
                </div>
              </Link>
            </li>
          ))}
        </ul>
        {!state.pending && !state.error && state.rows.length === 0 ? (
          <p className="px-[12px] py-[32px] text-muted-foreground">No notes match this search.</p>
        ) : null}
        {state.hasMore && state.offset <= 100_000 ? (
          <Button
            className="my-[16px]"
            variant="secondary"
            disabled={state.pending}
            onClick={loadMore}
          >
            {state.pending ? "Loading…" : "Load more results"}
          </Button>
        ) : null}
        {state.hasMore && state.offset > 100_000 ? (
          <p>The workspace pagination limit has been reached.</p>
        ) : null}
      </section>
    </>
  );
}
