"use client";

import { Button } from "@solyn/ui/components/button";
import { Input } from "@solyn/ui/components/input";
import { Label } from "@solyn/ui/components/label";
import { Textarea } from "@solyn/ui/components/textarea";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useReducer, useState, useTransition } from "react";

import { createNote, getNote, updateNote } from "./actions";
import { createNoteInput, updateNoteInput, type ErrorCode } from "./contracts";
import { editorReducer, initialEditor, isDirty, type Draft } from "./editor-state";
import { FieldError, MutationError } from "./feedback";
import { fieldErrors, formatDate, type FieldErrors, type Note } from "./presentation";
import { useUnsavedChanges } from "./use-unsaved-changes";

export default function NoteEditor({ projectId, initial }: { projectId: string; initial?: Note }) {
  const router = useRouter();
  const [state, dispatch] = useReducer(editorReducer, initial, initialEditor);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [navigating, startTransition] = useTransition();
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [latest, setLatest] = useState<Note | null>(null);
  const [reloadError, setReloadError] = useState<ErrorCode | null>(null);
  const pending = saving || navigating || loadingLatest;
  const dirty = isDirty(state);
  useUnsavedChanges(dirty || pending);
  function change(field: keyof Draft, value: string, invalidDate = false) {
    dispatch({ type: "edit", field, value });
    setErrors((current) => {
      if (!current[field]) return current; // No validation noise before submission.
      const draft = { ...state.draft, [field]: value };
      const parsed = createNoteInput.safeParse({
        projectId,
        ...draft,
        noteDate: draft.noteDate || null,
      });
      const next = { ...current };
      delete next[field];
      if (!parsed.success) {
        const message = fieldErrors(parsed.error)[field];
        if (message) next[field] = message;
      }
      if (field === "noteDate" && invalidDate) next.noteDate = "Please enter a valid date.";
      return next;
    });
  }

  async function loadLatest() {
    if (!state.saved) return;
    setLoadingLatest(true);
    setReloadError(null);
    try {
      const result = await getNote({ projectId, noteId: state.saved.id });
      if (!result.ok) {
        setReloadError(result.error.code);
        return;
      }
      setLatest(result.data); // Comparison only. Never advance expectedVersion here.
    } catch {
      setReloadError("UNAVAILABLE");
    } finally {
      setLoadingLatest(false);
    }
  }

  return (
    <div className="editor-wrap min-w-0 w-full">
      <form
        className="note-editor m-0 min-w-0 w-full"
        noValidate
        data-unsaved={dirty}
        aria-busy={pending}
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending || state.error === "CONFLICT") return;
          const form = event.currentTarget;
          const fields = {
            projectId,
            title: state.draft.title,
            content: state.draft.content,
            noteDate: state.draft.noteDate || null,
          };
          const parsed = state.saved
            ? updateNoteInput.safeParse({
                ...fields,
                noteId: state.saved.id,
                expectedVersion: state.saved.version,
              })
            : createNoteInput.safeParse(fields);
          const invalidDate =
            form.querySelector<HTMLInputElement>("#note-date")?.validity.valid === false;
          if (!parsed.success || invalidDate) {
            setErrors({
              ...(!parsed.success ? fieldErrors(parsed.error) : {}),
              ...(invalidDate ? { noteDate: "Please enter a valid date." } : {}),
            });
            requestAnimationFrame(() =>
              form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
            );
            return;
          }
          setErrors({});
          setSaving(true);
          try {
            const result = state.saved
              ? await updateNote(parsed.data)
              : await createNote(parsed.data);
            if (!result.ok) {
              dispatch({ type: "failed", code: result.error.code });
              return;
            }
            dispatch({ type: "saved", note: result.data });
            setLatest(null);
            startTransition(() => {
              if (!state.saved) router.replace(`/projects/${projectId}/notes/${result.data.id}`);
              router.refresh();
            });
          } catch {
            dispatch({ type: "failed", code: "UNAVAILABLE" });
          } finally {
            setSaving(false);
          }
        }}
      >
        <header className="page-heading -mx-[24px] mb-[20px] flex items-center justify-between gap-[16px] border-b border-solid border-border px-[24px] pb-[16px] [@media(min-width:761px)]:sticky [@media(min-width:761px)]:top-0 [@media(min-width:761px)]:z-10 [@media(min-width:761px)]:-mt-[20px] [@media(min-width:761px)]:bg-canvas [@media(min-width:761px)]:pt-[20px] [@media(max-width:1100px)]:flex-wrap [@media(max-width:760px)]:mx-0 [@media(max-width:760px)]:mb-[16px] [@media(max-width:760px)]:gap-[12px] [@media(max-width:760px)]:px-0">
          <h1 className="min-w-0 text-[16px] font-[600] tracking-[-0.015em] text-foreground">
            {initial ? "Edit Note" : "Create Note"}
          </h1>
          <div className="ml-auto flex items-center gap-[12px] [@media(max-width:760px)]:gap-[10px]">
            <p className="save-indicator text-[13px] text-muted-foreground" role="status">
              {pending
                ? loadingLatest
                  ? "Loading…"
                  : "Saving…"
                : dirty
                  ? "Unsaved changes"
                  : state.savedFeedback
                    ? "Saved"
                    : ""}
            </p>
            <Button
              type="submit"
              className="control"
              disabled={pending || (!!state.saved && !dirty) || state.error === "CONFLICT"}
            >
              {saving ? "Saving…" : state.saved ? "Save changes" : "Create note"}
            </Button>
          </div>
        </header>
        <FieldError id="note-form-error" message={errors.form} />
        <fieldset disabled={pending} className="editor-fields grid gap-[24px]">
          <div className="field grid gap-[9px]">
            <Label htmlFor="note-title">
              Title{" "}
              <span className="required-hint text-[12px] font-normal text-muted-foreground">
                (required)
              </span>
            </Label>
            <Input
              id="note-title"
              name="title"
              className="form-control title-input text-[18px] font-[550] tracking-[-0.015em]"
              value={state.draft.title}
              onChange={(event) => change("title", event.target.value)}
              maxLength={300}
              required
              autoComplete="off"
              placeholder="Note title"
              aria-invalid={!!errors.title}
              aria-describedby={errors.title ? "note-title-error" : undefined}
            />
            <FieldError id="note-title-error" message={errors.title} />
          </div>
          <div className="field date-field grid max-w-[440px] gap-[9px]">
            <Label htmlFor="note-date">
              Note date{" "}
              <span className="required-hint text-[12px] font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Input
              id="note-date"
              name="noteDate"
              type="date"
              className="form-control max-w-[220px]"
              min="0001-01-01"
              max="9999-12-31"
              value={state.draft.noteDate}
              onChange={(event) =>
                change("noteDate", event.target.value, !event.currentTarget.validity.valid)
              }
              aria-invalid={!!errors.noteDate}
              aria-describedby={`note-date-help${errors.noteDate ? " note-date-error" : ""}`}
              autoComplete="off"
            />
            <p
              id="note-date-help"
              className="field-help text-[12px] leading-[1.6] text-muted-foreground"
            >
              When it happened, if known. Not the date this note was created.
            </p>
            <FieldError id="note-date-error" message={errors.noteDate} />
          </div>
          <div className="field content-field grid gap-[9px]">
            <Label htmlFor="note-content">
              Note{" "}
              <span className="required-hint text-[12px] font-normal text-muted-foreground">
                (required)
              </span>
            </Label>
            <Textarea
              id="note-content"
              name="content"
              className="form-control writing-area h-[160px] max-h-[40dvh] field-sizing-fixed resize-none overflow-y-auto text-[17px] leading-[1.65] [@media(max-width:760px)]:text-[16px]"
              value={state.draft.content}
              onChange={(event) => change("content", event.target.value)}
              maxLength={100000}
              required
              spellCheck
              placeholder="Write your note…"
              aria-invalid={!!errors.content}
              aria-describedby={errors.content ? "note-content-error" : undefined}
              autoComplete="off"
            />
            <FieldError id="note-content-error" message={errors.content} />
          </div>
        </fieldset>
        {state.error ? (
          <div className="editor-feedback">
            <MutationError code={state.error} />
            {state.saved ? (
              <Button
                type="button"
                className="control mt-[14px]"
                variant="secondary"
                disabled={pending}
                onClick={loadLatest}
              >
                {loadingLatest ? "Loading…" : "Check latest saved version"}
              </Button>
            ) : (
              <p className="field-help text-[12px] leading-[1.6] text-muted-foreground">
                Before retrying an uncertain save,{" "}
                <Link
                  className="text-[#b2c7ff] [&:hover]:underline"
                  href={`/projects/${projectId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  check the project notes in a new tab
                </Link>{" "}
                to avoid creating a duplicate.
              </p>
            )}
          </div>
        ) : null}
        {reloadError ? <MutationError code={reloadError} /> : null}
        {latest ? (
          <section
            className="latest-version mt-[26px] grid gap-[14px] border-t border-border pt-[24px]"
            aria-label="Latest saved version"
          >
            <h2>Latest saved version</h2>
            <p className="text-muted-foreground">
              Version {latest.version}. Your draft above is unchanged. Copy anything you want to
              keep before replacing it.
            </p>
            <h3 className="[overflow-wrap:anywhere]">{latest.title}</h3>
            <p className="field-help text-[12px] leading-[1.6] text-muted-foreground">
              Note date: {latest.noteDate ? formatDate(latest.noteDate) : "Not set"}
            </p>
            <Textarea
              className="form-control saved-comparison h-[240px] max-h-[50dvh] field-sizing-fixed resize-none overflow-y-auto leading-[1.7]"
              readOnly
              value={latest.content}
              aria-label="Latest saved note content"
            />
            <Button
              type="button"
              variant="secondary"
              className="control justify-self-start"
              disabled={pending}
              onClick={() => {
                if (
                  dirty &&
                  !window.confirm(
                    "Replace your unsaved draft with the latest saved version? Copy anything you want to keep first.",
                  )
                )
                  return;
                dispatch({ type: "replace", note: latest });
                setLatest(null);
                setErrors({});
                setReloadError(null);
              }}
            >
              Use latest saved version
            </Button>
          </section>
        ) : null}
        {state.saved ? (
          <footer className="editor-metadata mt-[28px] flex flex-wrap gap-x-[22px] gap-y-[10px] border-t border-border pt-[18px] text-[12px] text-muted-foreground">
            <span>Created {formatDate(state.saved.createdAt)}</span>
            <span>Last saved {formatDate(state.saved.updatedAt)}</span>
            <span>Version {state.saved.version}</span>
          </footer>
        ) : null}
      </form>
    </div>
  );
}
