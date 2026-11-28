"use client";

import { Button } from "@solyn/ui/components/button";
import Link from "next/link";
import type { Route } from "next";
import { useEffect, useState, useTransition } from "react";
import type { getTaskSummary } from "./actions";
import type { ErrorCode, TaskOverview } from "./contracts";
import { formatDate } from "./presentation";
import { isOverdue, localCalendarDate, priorities, statuses } from "./task-state";

export type SummaryState = { loading: boolean; data: TaskOverview | null; error?: ErrorCode };
const initial: SummaryState = { loading: true, data: null };
// View-local, no cross-account/browser cache. Superseded/unmounted reads cannot
// restore links or yesterday's counts. Duplicate focus/visibility reads coalesce.
export function createSummaryReader(
  read: typeof getTaskSummary,
  publish: (state: SummaryState) => void,
) {
  let revision = 0;
  let pending: { date: string; promise: Promise<void> } | undefined;
  return {
    load(today: string): Promise<void> {
      if (pending?.date === today) return pending.promise;
      const current = ++revision;
      publish(initial);
      const promise = (async () => {
        // Register pending before invocation (including synchronous transport errors),
        // and avoid dispatching a read for an already-cleaned-up Strict Mode effect.
        await Promise.resolve();
        if (current !== revision) return;
        try {
          const result = await read({ today });
          if (current !== revision) return;
          if (!result.ok) publish({ loading: false, data: null, error: result.error.code });
          else if (result.data.today !== today)
            publish({ loading: false, data: null, error: "UNAVAILABLE" });
          else publish({ loading: false, data: result.data });
        } catch {
          if (current === revision) publish({ loading: false, data: null, error: "UNAVAILABLE" });
        } finally {
          if (current === revision) pending = undefined;
        }
      })();
      pending = { date: today, promise };
      return promise;
    },
    cancel() {
      revision++;
      pending = undefined;
    },
  };
}

export function SummaryContent({ state, retry }: { state: SummaryState; retry: () => void }) {
  const { data, loading, error } = state;
  const partial =
    !!data && (data.counts === null || data.attention === null || data.inProgress === null);
  const overdueHref = data ? `/tasks?status=pending&overdueBefore=${data.today}` : "/tasks";
  const soonHref = data
    ? `/tasks?status=pending&dueDateFrom=${data.today}&dueDateTo=${data.through}`
    : "/tasks";
  const attentionHref = data ? `/tasks?status=pending&dueDateTo=${data.through}` : "/tasks";
  const metrics = [
    { label: "Overdue", count: data?.counts?.overdue, href: overdueHref },
    { label: "Due soon", count: data?.counts?.dueSoon, href: soonHref },
    { label: "In Progress", count: data?.counts?.inProgress, href: "/tasks?status=in_progress" },
  ];
  function list(
    label: string,
    rows: TaskOverview["attention"] | undefined,
    href: string,
    empty: string,
  ) {
    return (
      <section className="min-w-0" aria-label={label}>
        <div className="mb-[6px] flex flex-wrap items-center justify-between gap-[8px]">
          <h3 className="text-[13px] font-[550]">{label}</h3>
          <Link
            href={href as Route}
            className="text-[12px] text-muted-foreground underline-offset-2 hover:underline"
          >
            View tasks
          </Link>
        </div>
        {loading ? (
          <p role="status" className="text-[13px] text-muted-foreground">
            Loading tasks…
          </p>
        ) : rows == null ? (
          <p className="text-[13px] text-muted-foreground">Tasks unavailable.</p>
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{empty}</p>
        ) : (
          <ul>
            {rows.map((task) => (
              <li key={task.id} className="rounded-[7px] px-[8px] py-[8px] hover:bg-(--hover)">
                <Link
                  href={`/tasks/${task.id}`}
                  className="block text-[14px] font-[550] [overflow-wrap:anywhere]"
                >
                  {task.title}
                </Link>
                <div className="mt-[3px] flex flex-wrap gap-x-[12px] gap-y-[3px] text-[12px] text-muted-foreground">
                  <Link
                    href={`/projects/${task.projectId}?view=tasks`}
                    className="max-w-full truncate underline-offset-2 hover:underline"
                  >
                    {task.projectName}
                  </Link>
                  <span>{statuses[task.status]}</span>
                  {task.priority ? (
                    <span className={task.priority === "urgent" ? "text-[#e6b98a]" : undefined}>
                      {priorities[task.priority]}
                    </span>
                  ) : null}
                  {task.dueDate ? (
                    <span
                      className={
                        isOverdue(task, data?.today ?? null) ? "text-[#e6b98a]" : undefined
                      }
                    >
                      <time dateTime={task.dueDate}>Due {formatDate(task.dueDate)}</time>
                      {isOverdue(task, data?.today ?? null) ? " · Overdue" : ""}
                    </span>
                  ) : (
                    <span>No deadline</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
  return (
    <section aria-label="Task overview" aria-busy={loading} className="mb-[24px]">
      <div className="mb-[12px] flex flex-wrap items-center justify-between gap-[8px]">
        <h2 className="text-[14px] font-[550]">Task overview</h2>
        <Button type="button" variant="secondary" disabled={loading} onClick={retry}>
          {loading ? "Loading…" : "Refresh summary"}
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-[12px] [@media(max-width:420px)]:grid-cols-1">
        {metrics.map((metric) => (
          <div key={metric.label} className="min-w-0">
            {data ? (
              <Link
                href={metric.href as Route}
                className="text-[13px] text-muted-foreground underline-offset-2 hover:underline"
              >
                {metric.label}
              </Link>
            ) : (
              <span className="text-[13px] text-muted-foreground">{metric.label}</span>
            )}
            <p className="mt-[3px] text-[20px] font-[550] tabular-nums [overflow-wrap:anywhere]">
              {loading ? "…" : metric.count === undefined ? "Unavailable" : metric.count}
            </p>
          </div>
        ))}
      </div>
      {data ? (
        <p className="mt-[8px] text-[12px] text-muted-foreground">
          Due soon: {formatDate(data.today)}–{formatDate(data.through)} · Local calendar · Counts
          may overlap.
        </p>
      ) : null}
      {error || partial ? (
        <div
          role="alert"
          className="mt-[12px] flex flex-wrap items-center gap-[12px] text-[13px] text-muted-foreground"
        >
          <p>
            {error === "UNAUTHENTICATED"
              ? "Your session has ended. Sign in, then retry the summary."
              : partial
                ? "Some task summary data is unavailable."
                : "Task summary unavailable."}
          </p>
          {error === "UNAUTHENTICATED" ? (
            <Link href="/login" className="underline">
              Sign in
            </Link>
          ) : null}
          <Button type="button" variant="secondary" onClick={retry}>
            Retry summary
          </Button>
        </div>
      ) : null}
      <div className="mt-[18px] grid grid-cols-2 gap-[24px] [@media(max-width:760px)]:grid-cols-1">
        {list("Needs attention", data?.attention, attentionHref, "No overdue or upcoming tasks.")}
        {list(
          "In Progress",
          data?.inProgress,
          "/tasks?status=in_progress",
          "No tasks in progress.",
        )}
      </div>
    </section>
  );
}

export default function WorkspaceSummary({ read }: { read: typeof getTaskSummary }) {
  const [state, setState] = useState<SummaryState>(initial);
  const [retry, setRetry] = useState(0);
  const [, startTransition] = useTransition();
  useEffect(() => {
    const reader = createSummaryReader(read, setState);
    let timer: ReturnType<typeof setTimeout>;
    function refresh() {
      clearTimeout(timer);
      if (document.visibilityState !== "hidden")
        startTransition(() => {
          void reader.load(localCalendarDate());
        });
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 50);
      timer = setTimeout(refresh, midnight.getTime() - Date.now());
    }
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      reader.cancel();
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [read, retry]);
  return <SummaryContent state={state} retry={() => setRetry((value) => value + 1)} />;
}
