import { buttonVariants } from "@solyn/ui/components/button";
import Link from "next/link";
import { notFound } from "next/navigation";
import RetryPanel from "@/features/workspace/retry-panel";
import { routeData } from "@/features/workspace/route-data";
import { workspace } from "@/features/workspace/server";
import TaskList from "@/features/workspace/task-list";
import { taskFilters, type TaskQuery } from "@/features/workspace/task-state";

export default async function TasksPage({ searchParams }: { searchParams: Promise<TaskQuery> }) {
  const filters = taskFilters(await searchParams);
  if (!filters.success) notFound();
  const [taskResult, projectResult] = await Promise.all([
    workspace.listOwnedTasks(filters.data),
    workspace.listProjects({ limit: 50, offset: 0 }),
  ]);
  const tasks = routeData(taskResult);
  const projects = routeData(projectResult);
  if (!tasks || !projects) return <RetryPanel />;
  let selectedProject;
  if (filters.data.projectId) {
    selectedProject =
      projects.find((project) => project.id === filters.data.projectId) ??
      routeData(await workspace.getProject({ projectId: filters.data.projectId }));
    if (!selectedProject) return <RetryPanel />;
  }
  return (
    <>
      <header className="page-heading -mx-[24px] mb-[20px] flex items-center justify-between gap-[16px] border-b border-solid border-border px-[24px] pb-[16px] [@media(max-width:760px)]:mx-0 [@media(max-width:760px)]:px-0">
        <h1 className="text-[16px] font-[600] tracking-[-0.015em]">Tasks</h1>
        <Link href="/tasks/new" className={buttonVariants()}>
          New task
        </Link>
      </header>
      <TaskList
        key={JSON.stringify(filters.data)}
        rows={tasks}
        filters={filters.data}
        projects={projects.map(({ id, name }) => ({ id, name }))}
        selectedProject={
          selectedProject ? { id: selectedProject.id, name: selectedProject.name } : undefined
        }
      />
    </>
  );
}
