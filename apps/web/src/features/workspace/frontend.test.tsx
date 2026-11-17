import assert from "node:assert/strict";
import { test } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { createNoteInput } from "./contracts";
import { editorReducer, initialEditor, isDirty } from "./editor-state";
import { Breadcrumbs, FieldError, MutationError } from "./feedback";
import {
  appendUnique,
  errorMessage,
  fieldErrors,
  formatDate,
  listKey,
  type Note,
} from "./presentation";

const note: Note = {
  id: "22222222-2222-4222-8222-222222222222",
  projectId: "11111111-1111-4111-8111-111111111111",
  title: "A note",
  content: "  Original\n\ncontent  ",
  noteDate: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  version: 1,
};

test("new and existing editors begin clean without inventing event dates", () => {
  assert.equal(isDirty(initialEditor()), false);
  assert.equal(initialEditor().saved, null);
  assert.equal(isDirty(initialEditor(note)), false);
  assert.equal(initialEditor(note).draft.content, note.content);
  assert.equal(initialEditor(note).draft.noteDate, "");
});

test("conflicts and unavailable saves retain the exact draft and outgoing expectedVersion", () => {
  for (const code of [
    "CONFLICT",
    "UNAVAILABLE",
    "UNAUTHENTICATED",
    "NOT_FOUND",
    "INVALID_INPUT",
  ] as const) {
    const edited = editorReducer(initialEditor(note), {
      type: "edit",
      field: "content",
      value: "  My unsaved draft\n\n ",
    });
    const failed = editorReducer(edited, { type: "failed", code });
    assert.equal(failed.draft.content, "  My unsaved draft\n\n ");
    assert.equal(failed.saved?.version, 1);
    assert.equal(failed.error, code);
    assert.equal(failed.savedFeedback, false);
    assert.equal(isDirty(failed), true);
  }
});

test("editing after conflict cannot clear conflict or silently advance its version", () => {
  const conflicted = editorReducer(initialEditor(note), { type: "failed", code: "CONFLICT" });
  const edited = editorReducer(conflicted, {
    type: "edit",
    field: "title",
    value: "Still my draft",
  });
  assert.equal(edited.error, "CONFLICT");
  assert.equal(edited.saved?.version, 1);
});

test("only confirmed saves adopt the returned state and version", () => {
  const edited = editorReducer(initialEditor(note), {
    type: "edit",
    field: "content",
    value: "New text",
  });
  const returned = { ...note, content: "New text", version: 2 };
  const saved = editorReducer(edited, { type: "saved", note: returned });
  assert.equal(saved.saved?.version, 2);
  assert.equal(saved.draft.content, "New text");
  assert.equal(saved.error, null);
  assert.equal(saved.savedFeedback, true);
  assert.equal(isDirty(saved), false);
});

test("explicit replacement adopts latest saved state; merely receiving it leaves draft unchanged", () => {
  const edited = editorReducer(initialEditor(note), {
    type: "edit",
    field: "content",
    value: "My draft",
  });
  const latest = { ...note, content: "Other session's edit", noteDate: "2024-02-29", version: 3 };
  assert.equal(edited.draft.content, "My draft");
  assert.equal(edited.saved?.version, 1);
  const replaced = editorReducer(edited, { type: "replace", note: latest });
  assert.equal(replaced.draft.content, latest.content);
  assert.equal(replaced.draft.noteDate, "2024-02-29");
  assert.equal(replaced.saved?.version, 3);
  assert.equal(isDirty(replaced), false);
});

test("returning fields to their saved values avoids unnecessary note updates", () => {
  const edited = editorReducer(initialEditor(note), {
    type: "edit",
    field: "title",
    value: "Changed",
  });
  assert.equal(isDirty(edited), true);
  assert.equal(
    isDirty(editorReducer(edited, { type: "edit", field: "title", value: note.title })),
    false,
  );
});

test("pagination appends distinct IDs without discarding existing rows", () => {
  const rows = [
    { id: "a", name: "first" },
    { id: "b", name: "second" },
  ];
  assert.deepEqual(
    appendUnique(rows, [
      { id: "b", name: "duplicate" },
      { id: "c", name: "third" },
      { id: "c", name: "duplicate again" },
    ]),
    [...rows, { id: "c", name: "third" }],
  );
  assert.deepEqual(appendUnique(rows, []), rows);
  assert.equal(rows.length, 2);
});

test("collection reset keys change after server-confirmed modifications", () => {
  assert.notEqual(
    listKey([note]),
    listKey([{ ...note, updatedAt: new Date("2026-01-02T00:00:00Z") }]),
  );
});

test("frontend validation uses the backend's exact contract and exposes field errors", () => {
  const result = createNoteInput.safeParse({
    projectId: note.projectId,
    title: " ",
    content: " ",
    noteDate: "2025-02-29",
  });
  assert.equal(result.success, false);
  if (!result.success) {
    const errors = fieldErrors(result.error);
    assert.ok(errors.title);
    assert.ok(errors.content);
    assert.ok(errors.noteDate);
  }
});

test("calendar date presentation never shifts a historical date by local timezone", () => {
  assert.equal(formatDate("2024-02-29"), "29 Feb 2024");
  assert.equal(formatDate(new Date("2024-02-29T23:59:59Z")), "29 Feb 2024");
});

test("errors have accessible announcements and session recovery does not navigate away from drafts", () => {
  const html = renderToStaticMarkup(<MutationError code="UNAUTHENTICATED" />);
  assert.match(html, /role="alert"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /href="\/login"/);
  assert.match(html, /draft is still here/);
  assert.match(
    renderToStaticMarkup(<FieldError id="title-error" message="Title is required" />),
    /id="title-error"/,
  );
  for (const code of ["CONFLICT", "NOT_FOUND", "UNAVAILABLE", "INVALID_INPUT"] as const)
    assert.ok(errorMessage(code).length > 20);
});

test("user-supplied project names are escaped in breadcrumbs", () => {
  const html = renderToStaticMarkup(
    <Breadcrumbs
      project={{ id: note.projectId, name: "<script>alert('x')</script>" }}
      current="Note"
    />,
  );
  assert.ok(!html.includes("<script>"));
  assert.match(html, /aria-label="Breadcrumb"/);
  assert.match(html, /aria-current="page"/);
});
