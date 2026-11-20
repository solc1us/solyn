import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { SearchNotesInput } from "./contracts";
import NoteSearch, { NoteSearchResults } from "./note-search";
import { createNoteSearch, type SearchAction } from "./note-search-state";
import type { SearchNote } from "./presentation";

type Result = Awaited<ReturnType<SearchAction>>;
const projectId = "11111111-1111-4111-8111-111111111111";
const ok = (data: SearchNote[]): Result => ({ ok: true, data });
const unavailable: Result = {
  ok: false,
  error: { code: "UNAVAILABLE", message: "private detail" },
};
const note = (index = 0): SearchNote => ({
  id: `${String(index).padStart(8, "0")}-2222-4222-8222-222222222222`,
  projectId,
  title: `Decision ${index}`,
  excerpt: "A bounded excerpt",
  noteDate: null,
  updatedAt: new Date("2026-01-02T00:00:00Z"),
});
const page = Array.from({ length: 20 }, (_, index) => note(index));
function fixture() {
  const requests: {
    input: SearchNotesInput;
    resolve: (result: Result) => void;
    reject: (error: Error) => void;
  }[] = [];
  const search = createNoteSearch(
    projectId,
    (input) =>
      new Promise<Result>((resolve, reject) => {
        requests.push({ input, resolve, reject });
      }),
  );
  const html = () =>
    renderToStaticMarkup(
      <NoteSearchResults projectId={projectId} state={search.getSnapshot()} loadMore={() => {}} />,
    );
  return { search, requests, html };
}

test("note search submits trimmed text with the fixed project and page size, never eagerly", async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0);
  assert.equal(f.search.getSnapshot().query, null);
  const attempt = f.search.submit("  Budget \n");
  assert.deepEqual(f.requests[0]!.input, { projectId, query: "Budget", limit: 20, offset: 0 });
  assert.equal(f.search.getSnapshot().pending, true);
  assert.match(f.html(), /Searching notes…/);
  assert.match(f.html(), /aria-busy="true"/);
  assert.doesNotMatch(f.html(), /No notes match/);
  await f.search.submit(" Budget "); // Synchronous duplicate-submit guard.
  assert.equal(f.requests.length, 1);
  f.requests[0]!.resolve(ok([note()]));
  await attempt;
  assert.equal(f.search.getSnapshot().pending, false);
  assert.equal(f.search.getSnapshot().hasMore, false);
  assert.match(f.html(), /1 result loaded for/);
});

for (const clear of ["button", "empty submission"] as const) {
  test(`note search ${clear} restores the normal list and invalidates an in-flight reply`, async () => {
    const f = fixture();
    const attempt = f.search.submit("old");
    if (clear === "button") f.search.clear();
    else await f.search.submit(" \n\t");
    assert.equal(f.search.getSnapshot().query, null);
    assert.equal(f.search.getSnapshot().pending, false);
    f.requests[0]!.resolve(ok([note()]));
    await attempt;
    assert.equal(f.search.getSnapshot().query, null);
    assert.deepEqual(f.search.getSnapshot().rows, []);
    assert.equal(f.requests.length, 1);
    assert.equal(f.html(), "");
  });
}

test("note search ignores older successes and errors after a newer submitted query", async () => {
  for (const reject of [false, true]) {
    const f = fixture();
    const older = f.search.submit("old");
    const newer = f.search.submit("new");
    assert.deepEqual(f.requests[1]!.input, { projectId, query: "new", limit: 20, offset: 0 });
    f.requests[1]!.resolve(ok([note(2)]));
    await newer;
    if (reject) f.requests[0]!.reject(new Error("private transport failure"));
    else f.requests[0]!.resolve(ok([note(1)]));
    await older;
    assert.equal(f.search.getSnapshot().query, "new");
    assert.deepEqual(f.search.getSnapshot().rows, [note(2)]);
    assert.equal(f.search.getSnapshot().error, null);
    assert.equal(f.search.getSnapshot().pending, false);
  }
});

test("note search paginates the submitted query, deduplicates IDs and advances by raw page length", async () => {
  const f = fixture();
  const first = f.search.submit("budget");
  f.requests[0]!.resolve(ok(page));
  await first;
  assert.equal(f.search.getSnapshot().hasMore, true);
  assert.match(f.html(), /Load more results/);
  const more = f.search.loadMore();
  await f.search.loadMore(); // Duplicate clicks do not issue a second request.
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1]!.input, { projectId, query: "budget", limit: 20, offset: 20 });
  assert.match(f.html(), /Loading more results…/);
  f.requests[1]!.resolve(ok([note(19), note(20), note(20)]));
  await more;
  assert.equal(f.search.getSnapshot().rows.length, 21);
  assert.equal(f.search.getSnapshot().offset, 23);
  assert.equal(f.search.getSnapshot().hasMore, false);
  assert.doesNotMatch(f.html(), /Load more results/);
  await f.search.loadMore();
  assert.equal(f.requests.length, 2);
});

test("note search preserves valid results and pagination offset after a failed page, allowing retry", async () => {
  const f = fixture();
  const first = f.search.submit("budget");
  f.requests[0]!.resolve(ok(page));
  await first;
  const more = f.search.loadMore();
  f.requests[1]!.resolve(unavailable);
  await more;
  assert.deepEqual(f.search.getSnapshot().rows, page);
  assert.equal(f.search.getSnapshot().offset, 20);
  assert.equal(f.search.getSnapshot().hasMore, true);
  assert.match(f.html(), /current results are unchanged/);
  assert.doesNotMatch(f.html(), /private detail/);
  const retry = f.search.loadMore();
  assert.deepEqual(f.requests[2]!.input, f.requests[1]!.input);
  f.requests[2]!.resolve(ok([]));
  await retry;
  assert.deepEqual(f.search.getSnapshot().rows, page);
  assert.equal(f.search.getSnapshot().error, null);
  assert.equal(f.search.getSnapshot().hasMore, false);
});

test("note search resets pagination for another query and ignores the superseded page", async () => {
  const f = fixture();
  const first = f.search.submit("old");
  f.requests[0]!.resolve(ok(page));
  await first;
  const more = f.search.loadMore();
  const next = f.search.submit("new");
  assert.deepEqual(f.search.getSnapshot().rows, []);
  assert.equal(f.search.getSnapshot().offset, 0);
  assert.deepEqual(f.requests[2]!.input, { projectId, query: "new", limit: 20, offset: 0 });
  f.requests[2]!.resolve(ok([note(30)]));
  await next;
  f.requests[1]!.resolve(ok([note(21)]));
  await more;
  assert.deepEqual(f.search.getSnapshot().rows, [note(30)]);
  assert.equal(f.search.getSnapshot().offset, 1);
});

test("note search distinguishes empty matches from an empty project and safely reports failures", async () => {
  const f = fixture();
  const empty = f.search.submit("absent");
  f.requests[0]!.resolve(ok([]));
  await empty;
  assert.match(f.html(), /No notes match this search/);
  assert.match(f.html(), /0 results loaded/);
  assert.doesNotMatch(f.html(), /No notes yet/);
  for (const code of ["UNAUTHENTICATED", "NOT_FOUND", "INVALID_INPUT", "UNAVAILABLE"] as const) {
    const attempt = f.search.submit("query");
    f.requests.at(-1)!.resolve({ ok: false, error: { code, message: "private detail" } });
    await attempt;
    assert.match(f.html(), /role="alert"/);
    assert.doesNotMatch(f.html(), /private detail|No notes match/);
    if (code === "UNAUTHENTICATED") assert.match(f.html(), /href="\/login"/);
  }
  const thrown = f.search.submit("query");
  f.requests.at(-1)!.reject(new Error("private transport detail"));
  await thrown;
  assert.equal(f.search.getSnapshot().error, "UNAVAILABLE");
  assert.doesNotMatch(f.html(), /private transport/);
});

test("note search ignores rejected requests after Clear", async () => {
  const f = fixture();
  const pending = f.search.submit("old");
  f.search.clear();
  f.requests[0]!.reject(new Error("late transport detail"));
  await pending;
  assert.equal(f.search.getSnapshot().error, null);
  assert.equal(f.html(), "");
});

test("note search renders plain-text excerpts, scoped links and distinct historical/edited dates", async () => {
  const f = fixture();
  const attempt = f.search.submit("source");
  f.requests[0]!.resolve(
    ok([
      {
        ...note(),
        title: "<script>unsafe()</script>",
        excerpt: '<img src=x onerror="unsafe()"> & text',
        noteDate: "2024-02-29",
      },
    ]),
  );
  await attempt;
  const html = f.html();
  assert.match(html, new RegExp(`href="/projects/${projectId}/notes/${note().id}"`));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /Note date: 29 Feb 2024/);
  assert.match(html, /Last edited 2 Jan 2026/);
  assert.match(html, /dateTime="2026-01-02T00:00:00.000Z"/i);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
});

test("note search form has a labeled search field, explicit submit/Clear, and keeps normal listing mounted", () => {
  let calls = 0;
  const html = renderToStaticMarkup(
    <NoteSearch
      projectId={projectId}
      searchAction={async () => {
        calls++;
        return ok([]);
      }}
    >
      <p>Normal notes collection</p>
    </NoteSearch>,
  );
  const id = html.match(/<input[^>]*id="([^"]+)"/)?.[1];
  assert.ok(id);
  assert.ok(html.includes(`for="${id}"`));
  assert.match(html, /role="search"/);
  assert.match(html, /type="search"/);
  assert.match(html, /maxLength="200"/i);
  assert.match(html, /type="submit"/);
  assert.match(html, />Search<\/button>/);
  assert.match(html, />Clear<\/button>/);
  assert.match(html, /<div><p>Normal notes collection<\/p><\/div>/);
  assert.equal(calls, 0);
});

test("note search action is a read-only delegate and the project page preserves Collection as its child", () => {
  const actions = readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
  assert.match(
    actions,
    /export async function searchNotes\(input: unknown\) \{\s*return workspace.searchNotes\(input\);\s*\}/,
  );
  const pageSource = readFileSync(
    new URL("../../app/(workspace)/projects/[projectId]/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    pageSource,
    /<NoteSearch[\s\S]*projectId=\{project.id\}[\s\S]*searchAction=\{searchNotes\}[\s\S]*<Collection key=\{listKey\(notes\)\} projectId=\{project.id\} initial=\{notes.map\(noteRow\)\} \/>[\s\S]*<\/NoteSearch>/,
  );
  const component = readFileSync(new URL("./note-search.tsx", import.meta.url), "utf8");
  assert.match(
    component,
    /onSubmit=\{[\s\S]*event.preventDefault\(\)[\s\S]*search.submit\(input\)/,
  );
  assert.match(
    component,
    /onChange=\{[\s\S]*setInput\(event.target.value\);\s*if \(!event.target.value.trim\(\)\) search.clear\(\);\s*\}\}/,
  );
  assert.match(component, /<div hidden=\{state.query !== null\}>\{children\}<\/div>/);
  assert.match(component, /field.current\?\.focus\(\)/);
});
