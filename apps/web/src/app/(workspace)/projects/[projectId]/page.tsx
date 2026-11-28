import { buttonVariants } from "@solyn/ui/components/button";
import { cn } from "@solyn/ui/lib/utils";
import { Plus, Pencil } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import TaskList from "@/features/workspace/task-list";
import { taskFilters, type TaskQuery } from "@/features/workspace/task-state";

import ProjectChatPopup from "@/features/chat/project-chat-popup";
import { searchNotes } from "@/features/workspace/actions";
import Collection from "@/features/workspace/collection";
import NoteSearch from "@/features/workspace/note-search";
import { Breadcrumbs } from "@/features/workspace/feedback";
import { formatDate, listKey, noteRow } from "@/features/workspace/presentation";
import RetryPanel from "@/features/workspace/retry-panel";
import { routeData } from "@/features/workspace/route-data";
import { workspace } from "@/features/workspace/server";

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<TaskQuery>;
}) {
  const { projectId } = await params;
  const query = await searchParams;
  const showTasks = query.view === "tasks";
  const filters = taskFilters(query, projectId);
  if (showTasks && !filters.success) notFound();
  const [projectResult, notesResult, tasksResult] = await Promise.all([
    workspace.getProject({ projectId }),
    showTasks ? null : workspace.listNotes({ projectId, limit: 50, offset: 0 }),
    showTasks && filters.success ? workspace.listTasks(filters.data) : null,
  ]);
  const project = routeData(projectResult);
  const notes = notesResult ? routeData(notesResult) : [];
  const tasks = tasksResult ? routeData(tasksResult) : null;
  if (!project || !notes || (showTasks && !tasks)) return <RetryPanel />;
  return (
    <div className="page-content px-[24px] pt-[20px] pb-[40px] [@media(max-width:760px)]:[padding:20px_max(16px,env(safe-area-inset-right))_max(40px,env(safe-area-inset-bottom))_max(16px,env(safe-area-inset-left))]">
      <Breadcrumbs current={project.name} />
      <header className="page-heading -mx-[24px] mb-[20px] flex min-h-[40px] items-center justify-between gap-[16px] border-b border-border px-[24px] pb-[16px] [@media(max-width:1100px)]:flex-wrap [@media(max-width:760px)]:mx-0 [@media(max-width:760px)]:mb-[16px] [@media(max-width:760px)]:gap-[12px] [@media(max-width:760px)]:px-0">
        <div className="min-w-0 flex-1 basis-[240px]">
          <h1 className="text-[16px] tracking-[-0.015em]">{project.name}</h1>
          {project.description ? (
            <p className="project-description mt-[8px] max-w-[64ch] text-[14px] leading-[1.6] whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
              {project.description}
            </p>
          ) : null}
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-[8px] self-start">
          <ProjectChatPopup project={{ id: project.id, name: project.name }} />
          <Link
            href={`/projects/${project.id}/edit`}
            className={cn(buttonVariants(), "bg-clip-border select-auto")}
          >
            <Pencil size={15} className="size-[15px]" aria-hidden="true" />
            Edit project
          </Link>
          <Link
            href={
              showTasks ? `/tasks/new?projectId=${project.id}` : `/projects/${project.id}/notes/new`
            }
            className={cn(buttonVariants(), "bg-clip-border select-auto")}
          >
            <Plus size={17} className="size-[17px]" aria-hidden="true" />
            {showTasks ? "New task" : "New note"}
          </Link>
        </div>
      </header>
      <div className="project-summary">
        <p className="metadata mt-[16px] max-w-[64ch] text-[12px] leading-[1.6] text-muted-foreground">
          Created {formatDate(project.createdAt)}
        </p>
      </div>
      <nav aria-label="Project views" className="mt-[24px] mb-[16px] flex gap-[20px] text-[14px]">
        <Link
          href={`/projects/${project.id}`}
          aria-current={!showTasks ? "page" : undefined}
          className="pb-[6px] text-muted-foreground aria-[current=page]:border-b aria-[current=page]:border-solid aria-[current=page]:border-ring aria-[current=page]:text-foreground"
        >
          Notes
        </Link>
        <Link
          href={`/projects/${project.id}?view=tasks`}
          aria-current={showTasks ? "page" : undefined}
          className="pb-[6px] text-muted-foreground aria-[current=page]:border-b aria-[current=page]:border-solid aria-[current=page]:border-ring aria-[current=page]:text-foreground"
        >
          Tasks
        </Link>
      </nav>
      {showTasks && tasks && filters.success ? (
        <TaskList
          key={`${project.id}:${JSON.stringify(filters.data)}`}
          rows={tasks}
          filters={filters.data}
          project={{ id: project.id, name: project.name }}
        />
      ) : (
        <NoteSearch
          key={`${project.id}:${listKey(notes)}`}
          projectId={project.id}
          searchAction={searchNotes}
        >
          <Collection key={listKey(notes)} projectId={project.id} initial={notes.map(noteRow)} />
        </NoteSearch>
      )}
    </div>
  );
}
