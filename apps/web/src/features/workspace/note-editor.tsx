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
  const change = (field: keyof Draft, value: string) => dispatch({ type: "edit", field, value });

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
    <div className="editor-wrap">
      <form
        className="note-editor"
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
          if (!parsed.success) {
            setErrors(fieldErrors(parsed.error));
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
        <div className="editor-toolbar">
          <p className="save-indicator" role="status">
            {pending
              ? loadingLatest
                ? "Loading…"
                : "Saving…"
              : state.savedFeedback
                ? "Saved"
                : dirty
                  ? "Unsaved changes"
                  : state.saved
                    ? "All changes saved"
                    : "New note"}
          </p>
          <Button
            type="submit"
            className="control"
            disabled={pending || (!!state.saved && !dirty) || state.error === "CONFLICT"}
          >
            {saving ? "Saving…" : state.saved ? "Save changes" : "Create note"}
          </Button>
        </div>
        <fieldset disabled={pending} className="editor-fields">
          <div className="field">
            <Label htmlFor="note-title">
              Title <span className="required-hint">(required)</span>
            </Label>
            <Input
              id="note-title"
              name="title"
              className="form-control title-input"
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
          <div className="field date-field">
            <Label htmlFor="note-date">
              Note date <span className="required-hint">(optional)</span>
            </Label>
            <Input
              id="note-date"
              name="noteDate"
              type="date"
              className="form-control"
              min="0001-01-01"
              max="9999-12-31"
              value={state.draft.noteDate}
              onChange={(event) => change("noteDate", event.target.value)}
              aria-invalid={!!errors.noteDate}
              aria-describedby={`note-date-help${errors.noteDate ? " note-date-error" : ""}`}
              autoComplete="off"
            />
            <p id="note-date-help" className="field-help">
              When it happened, if known. Not the date this note was created.
            </p>
            <FieldError id="note-date-error" message={errors.noteDate} />
          </div>
          <div className="field content-field">
            <Label htmlFor="note-content">
              Note <span className="required-hint">(required)</span>
            </Label>
            <Textarea
              id="note-content"
              name="content"
              className="form-control writing-area"
              value={state.draft.content}
              onChange={(event) => change("content", event.target.value)}
              maxLength={100000}
              required
              spellCheck
              placeholder="Write your note…"
              aria-invalid={!!errors.content}
              aria-describedby={`note-content-help${errors.content ? " note-content-error" : ""}`}
              autoComplete="off"
            />
            <p id="note-content-help" className="field-help">
              Plain text. Formatting and whitespace stay as you write them.
            </p>
            <FieldError id="note-content-error" message={errors.content} />
          </div>
        </fieldset>
        {state.error ? (
          <div className="editor-feedback">
            <MutationError code={state.error} />
            {state.saved ? (
              <Button
                type="button"
                className="control"
                variant="secondary"
                disabled={pending}
                onClick={loadLatest}
              >
                {loadingLatest ? "Loading…" : "Check latest saved version"}
              </Button>
            ) : (
              <p className="field-help">
                Before retrying an uncertain save,{" "}
                <Link
                  className="text-link"
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
          <section className="latest-version" aria-label="Latest saved version">
            <h2>Latest saved version</h2>
            <p>
              Version {latest.version}. Your draft above is unchanged. Copy anything you want to
              keep before replacing it.
            </p>
            <h3>{latest.title}</h3>
            <p className="field-help">
              Note date: {latest.noteDate ? formatDate(latest.noteDate) : "Not set"}
            </p>
            <Textarea
              className="form-control saved-comparison"
              readOnly
              value={latest.content}
              aria-label="Latest saved note content"
            />
            <Button
              type="button"
              variant="secondary"
              className="control"
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
        <footer className="editor-metadata">
          {state.saved ? (
            <>
              <span>Created {formatDate(state.saved.createdAt)}</span>
              <span>Last saved {formatDate(state.saved.updatedAt)}</span>
              <span>Version {state.saved.version}</span>
            </>
          ) : (
            <span>Nothing is saved until you choose Create note.</span>
          )}
        </footer>
      </form>
    </div>
  );
}
