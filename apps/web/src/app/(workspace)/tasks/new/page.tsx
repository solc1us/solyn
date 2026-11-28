import { Breadcrumbs } from "@/features/workspace/feedback";
import RetryPanel from "@/features/workspace/retry-panel";
import { routeData } from "@/features/workspace/route-data";
import { workspace } from "@/features/workspace/server";
import TaskEditor from "@/features/workspace/task-editor";
import type { TaskQuery } from "@/features/workspace/task-state";

export default async function NewTaskPage({ searchParams }: { searchParams: Promise<TaskQuery> }) {
  const query = await searchParams;
  if (query.projectId !== undefined) {
    const project = routeData(await workspace.getProject({ projectId: query.projectId }));
    if (!project) return <RetryPanel />;
    return (
      <>
        <Breadcrumbs
          root={{ href: "/tasks", label: "Tasks" }}
          project={project}
          current="Create Task"
        />
        <TaskEditor key={project.id} project={{ id: project.id, name: project.name }} />
      </>
    );
  }
  const projects = routeData(await workspace.listProjects({ limit: 50, offset: 0 }));
  if (!projects) return <RetryPanel />;
  return (
    <>
      <Breadcrumbs root={{ href: "/tasks", label: "Tasks" }} current="Create Task" />
      <TaskEditor key="global" projects={projects.map(({ id, name }) => ({ id, name }))} />
    </>
  );
}
