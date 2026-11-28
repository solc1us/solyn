"use client";

import { Button, buttonVariants } from "@solyn/ui/components/button";
import { Input } from "@solyn/ui/components/input";
import { Label } from "@solyn/ui/components/label";
import Link from "next/link";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { updateTask } from "./actions";
import type { ErrorCode } from "./contracts";
import { formatDate } from "./presentation";
import { ProjectSelect, type ProjectChoice } from "./task-pickers";
import {
  isOverdue,
  localCalendarDate,
  priorities,
  statuses,
  taskErrorMessage,
  taskFilters,
  taskPageHref,
  taskSelectClass,
  taskStatusChange,
  type TaskSummary,
} from "./task-state";
import type { z } from "zod";
import type { listOwnedTasksInput } from "./contracts";

type Filters = z.output<typeof listOwnedTasksInput>;
function TaskRow({ task, today }: { task: TaskSummary; today: string | null }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [error, setError] = useState<ErrorCode | null>(null);
  const busy = useRef(false);
  const overdue = isOverdue(task, today);
  return (
    <li className="rounded-[7px] px-[12px] py-[10px] hover:bg-(--hover) [@media(max-width:760px)]:px-[4px]">
      <div className="flex items-center gap-[12px]">
        <Link
          href={`/tasks/${task.id}`}
          className="min-w-0 flex-1 rounded-[4px] text-[14px] font-[550] [overflow-wrap:anywhere]"
        >
          {task.title}
        </Link>
        <Button
          type="button"
          variant="secondary"
          disabled={saving || refreshing || error === "CONFLICT" || error === "UNAVAILABLE"}
          aria-label={`${task.status === "done" ? "Reopen" : "Complete"} ${task.title}`}
          onClick={async () => {
            if (busy.current) return;
            busy.current = true;
            setSaving(true);
            setError(null);
            try {
              const result = await updateTask(taskStatusChange(task));
              if (!result.ok) {
                setError(result.error.code);
                return;
              }
              startTransition(() => router.refresh());
            } catch {
              setError("UNAVAILABLE");
            } finally {
              busy.current = false;
              setSaving(false);
            }
          }}
        >
          {saving || refreshing ? "Saving…" : task.status === "done" ? "Reopen" : "Done"}
        </Button>
      </div>
      <div className="mt-[4px] flex flex-wrap gap-x-[14px] gap-y-[4px] text-[12px] text-muted-foreground">
        <Link
          href={`/projects/${task.projectId}?view=tasks`}
          className="max-w-full truncate underline-offset-2 hover:underline"
        >
          {task.projectName}
        </Link>
        <span>{statuses[task.status as keyof typeof statuses]}</span>
        <span className={task.priority === "urgent" ? "text-[#e6b98a]" : undefined}>
          {task.priority ? priorities[task.priority as keyof typeof priorities] : "No priority"}
        </span>
        {task.dueDate ? (
          <span className={overdue ? "text-[#e6b98a]" : undefined}>
            <time dateTime={task.dueDate}>Due {formatDate(task.dueDate)}</time>
            {overdue ? " · Overdue" : ""}
          </span>
        ) : null}
        {task.assignee ? (
          <span className="max-w-full [overflow-wrap:anywhere]">PIC: {task.assignee}</span>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="mt-[8px] text-[13px] text-destructive">
          <p>
            {error === "CONFLICT"
              ? "This task changed elsewhere. Open it to review the latest version before changing status."
              : error === "UNAVAILABLE"
                ? "The status change could not be confirmed. Open the task to check its saved status before retrying."
                : taskErrorMessage(error)}
          </p>
          <Link className="underline" href={`/tasks/${task.id}`}>
            Open task to review
          </Link>
          {error === "UNAUTHENTICATED" ? (
            <Link
              className="ml-[12px] underline"
              href="/login"
              target="_blank"
              rel="noopener noreferrer"
            >
              Sign in
            </Link>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export default function TaskList({
  rows,
  filters,
  project,
  projects = [],
  selectedProject,
}: {
  rows: TaskSummary[];
  filters: Filters;
  project?: ProjectChoice;
  projects?: ProjectChoice[];
  selectedProject?: ProjectChoice;
}) {
  const [today, setToday] = useState<string | null>(null);
  const [filterProject, setFilterProject] = useState(filters.projectId ?? "");
  const [filterError, setFilterError] = useState(false);
  const [filtering, startFilterTransition] = useTransition();
  const router = useRouter();
  const base = (project ? `/projects/${project.id}?view=tasks` : "/tasks") as Route;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function update() {
      clearTimeout(timer);
      setToday(localCalendarDate());
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 50);
      timer = setTimeout(update, midnight.getTime() - Date.now());
    }
    update();
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return (
    <section aria-label={project ? "Project tasks" : "Your tasks"}>
      <form
        action={base.split("?")[0]}
        method="get"
        className="mb-[20px] grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] items-end gap-[12px]"
        aria-busy={filtering}
        onSubmit={(event) => {
          event.preventDefault();
          if (filtering) return;
          const data = new FormData(event.currentTarget);
          const parsed = taskFilters(
            Object.fromEntries(data.entries()) as Record<string, string>,
            project?.id,
          );
          if (!parsed.success) {
            setFilterError(true);
            return;
          }
          setFilterError(false);
          startFilterTransition(() => router.push(taskPageHref(base, parsed.data, 0)));
        }}
      >
        {project ? (
          <input type="hidden" name="view" value="tasks" />
        ) : (
          <ProjectSelect
            initial={projects}
            selected={selectedProject}
            value={filterProject}
            onChange={setFilterProject}
            all
          />
        )}
        <div className="grid gap-[6px]">
          <Label htmlFor="filter-status">Status</Label>
          <select
            id="filter-status"
            name="status"
            className={taskSelectClass}
            defaultValue={filters.status ?? ""}
          >
            <option value="">All statuses</option>
            <option value="pending">Incomplete</option>
            {Object.entries(statuses).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-[6px]">
          <Label htmlFor="filter-priority">Priority</Label>
          <select
            id="filter-priority"
            name="priority"
            className={taskSelectClass}
            defaultValue={filters.priority === null ? "none" : (filters.priority ?? "")}
          >
            <option value="">All priorities</option>
            <option value="none">No priority</option>
            {Object.entries(priorities).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-[6px]">
          <Label htmlFor="filter-from">Due from</Label>
          <Input
            id="filter-from"
            name="dueDateFrom"
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            className="form-control"
            defaultValue={filters.dueDateFrom ?? ""}
          />
        </div>
        <div className="grid gap-[6px]">
          <Label htmlFor="filter-to">Due through</Label>
          <Input
            id="filter-to"
            name="dueDateTo"
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            className="form-control"
            defaultValue={filters.dueDateTo ?? ""}
          />
        </div>
        {filters.overdueBefore ? (
          <div className="grid gap-[6px]">
            <Label htmlFor="filter-overdue">Overdue before</Label>
            <Input
              id="filter-overdue"
              name="overdueBefore"
              type="date"
              min="0001-01-01"
              max="9999-12-31"
              className="form-control"
              defaultValue={filters.overdueBefore}
            />
          </div>
        ) : null}
        <div className="flex min-h-[36px] items-center gap-[12px]">
          <Button type="submit" disabled={filtering}>
            {filtering ? "Loading…" : "Apply filters"}
          </Button>
          <Link className="text-[13px] underline" href={base}>
            Reset
          </Link>
        </div>
        {filterError ? (
          <p role="alert" className="col-span-full text-[13px] text-destructive">
            Check the filter values and put the earlier due date first.
          </p>
        ) : null}
      </form>
      {rows.length ? (
        Object.entries(statuses).map(([status, label]) => {
          const group = rows.filter((task) => task.status === status);
          return group.length ? (
            <section key={status} aria-label={`${label} tasks on this page`} className="mb-[18px]">
              <h2 className="mb-[6px] px-[12px] text-[13px] font-medium text-muted-foreground">
                {label}
              </h2>
              <ul className="m-0 list-none p-0">
                {group.map((task) => (
                  <TaskRow key={task.id} task={task} today={today} />
                ))}
              </ul>
            </section>
          ) : null;
        })
      ) : (
        <div className="py-[48px] text-center text-muted-foreground">
          <p>No tasks match this view.</p>
          <Link
            className={buttonVariants({ className: "mt-[16px]" })}
            href={project ? `/tasks/new?projectId=${project.id}` : "/tasks/new"}
          >
            New task
          </Link>
        </div>
      )}
      <footer className="flex flex-wrap items-center justify-between gap-[16px] py-[16px] text-[12px] text-muted-foreground">
        <p role="status">{filtering ? "Loading tasks…" : `${rows.length} tasks on this page`}</p>
        <nav aria-label="Task pages" className="flex gap-[16px]">
          {filters.offset > 0 ? (
            <Link
              className="underline"
              href={taskPageHref(base, filters, Math.max(0, filters.offset - 50))}
            >
              Previous page
            </Link>
          ) : null}
          {rows.length === 50 && filters.offset + 50 <= 100_000 ? (
            <Link className="underline" href={taskPageHref(base, filters, filters.offset + 50)}>
              Next page
            </Link>
          ) : null}
          {rows.length === 50 && filters.offset + 50 > 100_000 ? (
            <span>Pagination limit reached.</span>
          ) : null}
        </nav>
      </footer>
    </section>
  );
}
