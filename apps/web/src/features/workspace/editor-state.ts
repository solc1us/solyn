import type { ErrorCode } from "./contracts";
import type { Note } from "./presentation";

export type Draft = { title: string; content: string; noteDate: string };
export type EditorState = {
  saved: Note | null;
  draft: Draft;
  error: ErrorCode | null;
  savedFeedback: boolean;
};
export function noteDraft(note?: Note | null): Draft {
  return { title: note?.title ?? "", content: note?.content ?? "", noteDate: note?.noteDate ?? "" };
}
export function initialEditor(note?: Note): EditorState {
  return { saved: note ?? null, draft: noteDraft(note), error: null, savedFeedback: false };
}
export function isDirty(state: EditorState) {
  const baseline = noteDraft(state.saved);
  return (
    state.draft.title !== baseline.title ||
    state.draft.content !== baseline.content ||
    state.draft.noteDate !== baseline.noteDate
  );
}
export type EditorEvent =
  | { type: "edit"; field: keyof Draft; value: string }
  | { type: "saved"; note: Note }
  | { type: "failed"; code: ErrorCode }
  | { type: "replace"; note: Note };
export function editorReducer(state: EditorState, event: EditorEvent): EditorState {
  switch (event.type) {
    case "edit":
      return {
        ...state,
        draft: { ...state.draft, [event.field]: event.value },
        savedFeedback: false,
      };
    case "saved":
      return { saved: event.note, draft: noteDraft(event.note), error: null, savedFeedback: true };
    case "failed":
      return { ...state, error: event.code, savedFeedback: false };
    // Only dispatched after explicit confirmation; merely loading the latest note
    // for comparison must never update the draft or its expected version.
    case "replace":
      return initialEditor(event.note);
  }
}
