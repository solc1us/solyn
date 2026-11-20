import type { searchNotes } from "./actions";
import type { ErrorCode, SearchNotesInput } from "./contracts";
import { appendUnique, type SearchNote } from "./presentation";

export type SearchAction = (input: SearchNotesInput) => ReturnType<typeof searchNotes>;
export type NoteSearchState = {
  query: string | null;
  rows: SearchNote[];
  offset: number;
  hasMore: boolean;
  pending: boolean;
  error: ErrorCode | null;
};
const emptyState = (): NoteSearchState => ({
  query: null,
  rows: [],
  offset: 0,
  hasMore: false,
  pending: false,
  error: null,
});

// One instance per project component; no persistence, cache or automatic fetches.
export function createNoteSearch(projectId: string, searchAction: SearchAction) {
  let state = emptyState();
  let generation = 0;
  const listeners = new Set<() => void>();
  function update(change: Partial<NoteSearchState>) {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  }
  function clear() {
    generation++;
    update(emptyState());
  }
  async function load(query: string, offset: number) {
    const request = ++generation;
    update({
      query,
      ...(offset === 0 ? { rows: [], offset: 0, hasMore: false } : {}),
      pending: true,
      error: null,
    });
    try {
      const result = await searchAction({ projectId, query, limit: 20, offset });
      if (request !== generation) return;
      if (!result.ok) {
        update({ pending: false, error: result.error.code });
        return;
      }
      update({
        rows: appendUnique(state.rows, result.data),
        // Advance by the raw page length, not the deduplicated displayed count.
        offset: offset + result.data.length,
        hasMore: result.data.length === 20,
        pending: false,
        error: null,
      });
    } catch {
      if (request === generation) update({ pending: false, error: "UNAVAILABLE" });
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear,
    async submit(input: string) {
      const query = input.trim();
      if (!query) return clear();
      if (state.pending && state.query === query) return;
      return load(query, 0);
    },
    async loadMore() {
      if (state.pending || !state.query || !state.hasMore || state.offset > 100_000) return;
      return load(state.query, state.offset);
    },
  };
}
