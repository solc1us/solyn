import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Breadcrumbs } from "./feedback";
import { formatDate } from "./presentation";
import {
  createTaskEditor,
  isOverdue,
  localCalendarDate,
  taskDeletePrompt,
  taskDirty,
  taskDraft,
  taskErrorMessage,
  taskFilters,
  taskPageHref,
  taskPayload,
  taskStatusChange,
  type Task,
} from "./task-state";

const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const noteId = "33333333-3333-4333-8333-333333333333";
const otherProjectId = "44444444-4444-4444-8444-444444444444";
const task: Task = {
  id: taskId,
  projectId,
  title: "Original task",
  description: "  Exact\ntext  ",
  status: "todo",
  priority: "high",
  dueDate: "2026-01-15",
  assignee: "PIC",
  sourceNoteId: noteId,
  version: 3,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
  completedAt: null,
};
const ok = <T,>(data: T) => ({ ok: true as const, data });
const fail = (
  code: "CONFLICT" | "UNAVAILABLE" | "NOT_FOUND" | "INVALID_INPUT" | "UNAUTHENTICATED",
) => ({ ok: false as const, error: { code, message: "safe" } });
type Actions = Parameters<typeof createTaskEditor>[2];
function fixture(initial?: Task, project = "", overrides: Partial<Actions> = {}) {
  const calls: { operation: string; input: unknown }[] = [];
  const actions: Actions = {
    create: async (input) => {
      calls.push({ operation: "create", input });
      return ok({ ...task, version: 1 });
    },
    update: async (input) => {
      calls.push({ operation: "update", input });
      return ok({ ...task, version: 4, title: "Changed" });
    },
    remove: async (input) => {
      calls.push({ operation: "delete", input });
      return ok({ id: taskId, projectId });
    },
    read: async (input) => {
      calls.push({ operation: "read", input });
      return ok({ ...task, version: 4, title: "Remote" });
    },
    ...overrides,
  };
  return { editor: createTaskEditor(initial, project, actions), calls };
}
function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("task creation validates required project/title and rejects native incomplete dates without sending", async () => {
  const { editor, calls } = fixture();
  assert.equal(await editor.save(), null);
  assert.ok(editor.getSnapshot().errors.projectId);
  assert.ok(editor.getSnapshot().errors.title);
  editor.change("title", " ");
  assert.ok(editor.getSnapshot().errors.title);
  editor.change("projectId", projectId);
  editor.change("title", "New task");
  assert.equal(await editor.save(true), null);
  assert.ok(editor.getSnapshot().errors.dueDate);
  assert.deepEqual(calls, []);
  await editor.save();
  assert.deepEqual(calls[0], {
    operation: "create",
    input: {
      projectId,
      title: "New task",
      description: null,
      status: "todo",
      priority: null,
      assignee: null,
      dueDate: null,
      sourceNoteId: null,
    },
  });
  assert.equal(editor.getSnapshot().saved?.version, 1);
  assert.equal(editor.getSnapshot().savedFeedback, true);
});

test("global project changes clear source selection; fixed create and saved projects cannot be reassigned", () => {
  const global = fixture().editor;
  global.change("projectId", projectId);
  global.change("sourceNoteId", noteId);
  global.change("projectId", otherProjectId);
  assert.equal(global.getSnapshot().draft.sourceNoteId, "");
  const fixed = fixture(undefined, projectId).editor;
  fixed.change("projectId", otherProjectId);
  assert.equal(fixed.getSnapshot().draft.projectId, projectId);
  const edit = fixture(task).editor;
  edit.change("projectId", otherProjectId);
  assert.equal(edit.getSnapshot().draft.projectId, projectId);
  assert.equal(
    taskPayload({ ...taskDraft(task), projectId: otherProjectId, title: "Changed" }, task).success,
    false,
  );
});

test("task payload preserves omitted nullable/source fields and expectedVersion; explicit clears use null", () => {
  const draft = { ...taskDraft(task), title: "Changed" };
  const parsed = taskPayload(draft, task);
  assert.ok(parsed.success);
  assert.deepEqual(parsed.data, { taskId, expectedVersion: 3, title: "Changed" });
  const clear = taskPayload(
    { ...draft, description: "", priority: "", assignee: "", dueDate: "", sourceNoteId: "" },
    task,
  );
  assert.ok(clear.success);
  assert.deepEqual(clear.data, {
    taskId,
    expectedVersion: 3,
    title: "Changed",
    description: null,
    priority: null,
    assignee: null,
    dueDate: null,
    sourceNoteId: null,
  });
  assert.equal(taskPayload(taskDraft(task), task).success, false);
  assert.equal(taskDirty(taskDraft(task), task), false);
  assert.equal(taskDirty({ ...taskDraft(task), description: "  Exact\ntext " }, task), true);
});

test("task form retains exact description/PIC text and validates all fields through P5.2 schemas", () => {
  const draft = {
    ...taskDraft(undefined, projectId),
    title: " New task ",
    description: "  Keep\ntext  ",
    assignee: "  PIC  ",
    dueDate: "2024-02-29",
    status: "done",
    priority: "urgent",
  };
  const parsed = taskPayload(draft);
  assert.ok(parsed.success);
  assert.equal(parsed.data.title, "New task");
  assert.equal(parsed.data.description, draft.description);
  assert.equal(parsed.data.assignee, draft.assignee);
  for (const bad of [
    { title: " " },
    { title: "x".repeat(301) },
    { description: "\0" },
    { assignee: "\ud800" },
    { dueDate: "2026-02-30" },
    { status: "overdue" },
    { priority: "invalid" },
  ])
    assert.equal(taskPayload({ ...draft, ...bad }).success, false);
});

test("duplicate task saves are blocked synchronously; successful updates adopt the confirmed version", async () => {
  let resolve!: (result: Awaited<ReturnType<Actions["update"]>>) => void;
  let writes = 0;
  const { editor } = fixture(task, "", {
    update: async (input) => {
      writes++;
      assert.deepEqual(input, { taskId, expectedVersion: 3, title: "Changed" });
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  editor.change("title", "Changed");
  const first = editor.save();
  assert.equal(editor.getSnapshot().pending, "save");
  assert.equal(await editor.save(), null);
  assert.equal(writes, 1);
  editor.change("title", "Cannot change pending input");
  assert.equal(editor.getSnapshot().draft.title, "Changed");
  resolve(ok({ ...task, title: "Changed", version: 4 }));
  assert.ok(await first);
  assert.equal(editor.getSnapshot().saved?.version, 4);
  assert.equal(taskDirty(editor.getSnapshot().draft, editor.getSnapshot().saved), false);
});

test("conflict reload is comparison-only; explicit adoption is required before any retry/delete", async () => {
  const f = fixture(task, "", { update: async () => fail("CONFLICT") });
  f.editor.change("title", "My draft");
  await f.editor.save();
  assert.equal(f.editor.getSnapshot().error, "CONFLICT");
  await f.editor.loadLatest();
  assert.equal(f.editor.getSnapshot().draft.title, "My draft");
  assert.equal(f.editor.getSnapshot().saved?.version, 3);
  assert.equal(f.editor.getSnapshot().latest?.version, 4);
  assert.equal(await f.editor.save(), null);
  assert.equal(await f.editor.remove(() => true), false);
  assert.deepEqual(
    f.calls.map((c) => c.operation),
    ["read"],
  );
  f.editor.useLatest();
  assert.equal(f.editor.getSnapshot().saved?.version, 4);
  assert.equal(f.editor.getSnapshot().draft.title, "Remote");
  assert.equal(f.editor.getSnapshot().error, null);
});

test("uncertain creation cannot auto-retry; explicit persisted-task check acknowledgement is required", async () => {
  let attempts = 0;
  const f = fixture(undefined, projectId, {
    create: async () => {
      attempts++;
      throw new Error("lost acknowledgement");
    },
  });
  f.editor.change("title", "Keep my task");
  await f.editor.save();
  assert.equal(f.editor.getSnapshot().error, "UNAVAILABLE");
  assert.equal(f.editor.getSnapshot().draft.title, "Keep my task");
  await f.editor.save();
  assert.equal(attempts, 1);
  f.editor.allowCreateRetry(() => false);
  await f.editor.save();
  assert.equal(attempts, 1);
  f.editor.allowCreateRetry((message) => {
    assert.match(message, /checked persisted tasks/);
    assert.match(message, /duplicate/);
    return true;
  });
  await f.editor.save();
  assert.equal(attempts, 2);
});

test("failed updates and latest-version reads preserve the draft and original expectedVersion", async () => {
  for (const code of ["UNAVAILABLE", "NOT_FOUND", "INVALID_INPUT", "UNAUTHENTICATED"] as const) {
    const f = fixture(task, "", {
      update: async () => fail(code),
      read: async () => fail("NOT_FOUND"),
    });
    f.editor.change("description", "  Unsaved\ntext  ");
    await f.editor.save();
    await f.editor.loadLatest();
    assert.equal(f.editor.getSnapshot().saved?.version, 3);
    assert.equal(f.editor.getSnapshot().draft.description, "  Unsaved\ntext  ");
    assert.equal(f.editor.getSnapshot().reloadError, "NOT_FOUND");
    assert.equal(f.editor.getSnapshot().latest, null);
  }
});

test("delete confirmation identifies saved task and unsaved loss; cancel never invokes the action", async () => {
  const f = fixture(task);
  f.editor.change("title", "Unsaved title");
  assert.equal(
    await f.editor.remove((message) => {
      assert.ok(message.includes(task.title));
      assert.match(message, /unsaved changes/);
      assert.match(message, /source note and history will be kept/);
      return false;
    }),
    false,
  );
  assert.deepEqual(f.calls, []);
  assert.equal(f.editor.getSnapshot().deleted, false);
  assert.equal(await f.editor.remove(() => true), true);
  assert.deepEqual(f.calls, [{ operation: "delete", input: { taskId, expectedVersion: 3 } }]);
  assert.equal(f.editor.getSnapshot().deleted, true);
  assert.equal(await f.editor.remove(() => true), false);
  assert.equal(await f.editor.save(), null);
  assert.match(taskDeletePrompt(task, false), /cannot be undone/);
});

test("failed/conflicting/ambiguous deletes do not retire state or discard local input", async () => {
  for (const code of ["CONFLICT", "UNAVAILABLE", "NOT_FOUND", "UNAUTHENTICATED"] as const) {
    let calls = 0;
    const f = fixture(task, "", {
      remove: async () => {
        calls++;
        return fail(code);
      },
    });
    f.editor.change("title", "Keep this draft");
    assert.equal(await f.editor.remove(() => true), false);
    assert.equal(f.editor.getSnapshot().deleted, false);
    assert.equal(f.editor.getSnapshot().draft.title, "Keep this draft");
    if (code === "CONFLICT" || code === "UNAVAILABLE") {
      await f.editor.remove(() => true);
      assert.equal(calls, 1);
    }
  }
});

test("status completion/reopening sends only server-supported status and current expectedVersion", () => {
  for (const status of ["todo", "in_progress", "blocked", "done"]) {
    assert.deepEqual(taskStatusChange({ ...task, status }), {
      taskId,
      expectedVersion: 3,
      status: status === "done" ? "todo" : "done",
    });
  }
  const payload = taskPayload({ ...taskDraft(task), status: "done" }, task);
  assert.ok(payload.success);
  assert.equal("completedAt" in payload.data, false);
});

test("URL task filters validate priority-null, dates, bounded offsets and immutable project scope", () => {
  const parsed = taskFilters({
    projectId,
    status: "blocked",
    priority: "none",
    dueDateFrom: "2026-01-01",
    dueDateTo: "2026-02-01",
    offset: "50",
  });
  assert.ok(parsed.success);
  assert.equal(parsed.data.priority, null);
  assert.equal(parsed.data.offset, 50);
  assert.equal(parsed.data.limit, 50);
  const fixed = taskFilters({ projectId: otherProjectId }, projectId);
  assert.ok(fixed.success);
  assert.equal(fixed.data.projectId, projectId);
  const defaults = taskFilters({ priority: "", status: "", offset: "" });
  assert.ok(defaults.success);
  assert.equal(defaults.data.offset, 0);
  assert.equal(defaults.data.priority, undefined);
  for (const query of [
    { status: ["todo", "done"] },
    { priority: "null" },
    { offset: "100001" },
    { offset: "1e2" },
    { offset: "-1" },
    { dueDateFrom: "2026-03-01", dueDateTo: "2026-02-01" },
    { projectId: "bad" },
  ])
    assert.equal(taskFilters(query).success, false);
});

test("pagination retains server filters/tab context while filter forms omit/reset the previous offset", () => {
  const filters = taskFilters({ projectId, priority: "none", status: "todo", offset: "50" });
  assert.ok(filters.success);
  const next = new URL(taskPageHref("/tasks", filters.data, 100), "https://test.invalid");
  assert.equal(next.searchParams.get("projectId"), projectId);
  assert.equal(next.searchParams.get("priority"), "none");
  assert.equal(next.searchParams.get("offset"), "100");
  const project = new URL(
    taskPageHref(`/projects/${projectId}?view=tasks`, filters.data, 0),
    "https://test.invalid",
  );
  assert.equal(project.searchParams.get("view"), "tasks");
  assert.equal(project.searchParams.has("projectId"), false);
  assert.equal(project.searchParams.has("offset"), false);
  const list = source("./task-list.tsx");
  assert.doesNotMatch(list, /name="offset"/);
  assert.match(list, /method="get"/);
  assert.match(list, /tasks on this page/);
  assert.doesNotMatch(list, /total tasks/i);
});

test("overdue uses the user's local date, not UTC timestamps; today/undated/done are not overdue", () => {
  assert.equal(localCalendarDate(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(isOverdue({ status: "todo", dueDate: "2026-01-04" }, "2026-01-05"), true);
  for (const status of ["todo", "in_progress", "blocked", "done"])
    assert.equal(isOverdue({ status, dueDate: "2026-01-05" }, "2026-01-05"), false);
  assert.equal(isOverdue({ status: "done", dueDate: "2026-01-04" }, "2026-01-05"), false);
  assert.equal(isOverdue({ status: "todo", dueDate: null }, "2026-01-05"), false);
  assert.equal(isOverdue({ status: "todo", dueDate: "2026-01-04" }, null), false);
  assert.equal(formatDate("2026-01-05"), "5 Jan 2026");
  assert.match(source("./task-list.tsx"), /useState<string \| null>\(null\)/);
});

test("source/project pickers paginate raw authorized pages, retain outside-page references and discard old project reads", () => {
  const pickers = source("./task-pickers.tsx");
  assert.match(pickers, /listProjects\(\{ limit: 50, offset \}\)/);
  assert.match(pickers, /listNotes\(\{ projectId, limit: 50, offset: start \}\)/);
  assert.match(pickers, /start \+ result.data.length/);
  assert.match(pickers, /offset \+ result.data.length/);
  assert.match(pickers, /if \(!active.current\) return/);
  assert.match(pickers, /Current source note/);
  assert.match(pickers, /Load more notes/);
  assert.match(source("./task-editor.tsx"), /SourceNoteSelect\s+key=\{state.draft.projectId\}/);
});

test("task routes use the approved operations, canonical editor and URL-backed project tabs without schema changes", () => {
  const root = "../../app/(workspace)/";
  assert.match(source(`${root}tasks/page.tsx`), /workspace.listOwnedTasks\(filters.data\)/);
  assert.match(
    source(`${root}tasks/new/page.tsx`),
    /workspace.getProject\(\{ projectId: query.projectId \}\)/,
  );
  const edit = source(`${root}tasks/[taskId]/page.tsx`);
  assert.match(edit, /workspace.getTask\(\{ taskId \}\)/);
  assert.match(
    edit,
    /workspace.getNote\(\{ projectId: task.projectId, noteId: task.sourceNoteId \}\)/,
  );
  const project = source(`${root}projects/[projectId]/page.tsx`);
  assert.match(project, /query.view === "tasks"/);
  assert.match(project, /workspace.listTasks\(filters.data\)/);
  for (const existing of ["ProjectChatPopup", "NoteSearch", "Collection", "project.description"])
    assert.ok(project.includes(existing));
  const shell = source("../../components/workspace-shell.tsx");
  assert.ok(shell.indexOf('href="/projects"') < shell.indexOf('href="/tasks"'));
  assert.ok(shell.indexOf('href="/tasks"') < shell.indexOf('href="/chat"'));
  assert.match(shell, /pathname.startsWith\("\/tasks"\)/);
});

test("task form retains approved semantic header/layout, guard, explicit conflict review and post-success navigation", () => {
  const editor = source("./task-editor.tsx");
  assert.match(editor, /<h1[^>]*>\s*\{state.saved \? "Edit Task" : "Create Task"\}\s*<\/h1>/);
  assert.ok(editor.indexOf("<h1") < editor.indexOf('role="status"'));
  for (const value of [
    "border-solid",
    "border-b",
    "form-control h-[160px]",
    "resize-none",
    "overflow-y-auto",
    "useUnsavedChanges",
    "data-unsaved",
    "Use latest saved version",
    "window.confirm",
    "router.replace",
  ])
    assert.ok(editor.includes(value));
  const actions = source("./actions.ts");
  assert.match(
    actions,
    /if \(taskId\) \{\s*revalidatePath\("\/tasks"\);\s*revalidatePath\(`\/tasks\/\$\{taskId\}`\);/,
  );
  const crumbs = renderToStaticMarkup(
    <Breadcrumbs root={{ href: "/tasks", label: "Tasks" }} current="Create Task" />,
  );
  assert.match(crumbs, /href="\/tasks"/);
  assert.match(crumbs, /aria-current="page"/);
  assert.doesNotMatch(taskErrorMessage("CONFLICT"), /This note/);
  assert.match(editor, /if \(!active.current\) return/);
  assert.ok(editor.includes("&& active.current"));
});
