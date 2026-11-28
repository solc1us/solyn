import { Breadcrumbs } from "@/features/workspace/feedback";
import RetryPanel from "@/features/workspace/retry-panel";
import { routeData } from "@/features/workspace/route-data";
import { workspace } from "@/features/workspace/server";
import TaskEditor from "@/features/workspace/task-editor";

export default async function TaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const task = routeData(await workspace.getTask({ taskId }));
  if (!task) return <RetryPanel />;
  const [projectResult, sourceResult] = await Promise.all([
    workspace.getProject({ projectId: task.projectId }),
    task.sourceNoteId
      ? workspace.getNote({ projectId: task.projectId, noteId: task.sourceNoteId })
      : null,
  ]);
  const project = routeData(projectResult);
  if (!project) return <RetryPanel />;
  const source = sourceResult?.ok
    ? { id: sourceResult.data.id, title: sourceResult.data.title }
    : undefined;
  return (
    <>
      <Breadcrumbs
        root={{ href: "/tasks", label: "Tasks" }}
        project={project}
        current="Edit Task"
      />
      <TaskEditor
        key={task.id}
        initial={task}
        project={{ id: project.id, name: project.name }}
        initialSource={source}
      />
    </>
  );
}
