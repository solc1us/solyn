import { Breadcrumbs } from "@/features/workspace/feedback";
import ProjectForm from "@/features/workspace/project-form";
import RetryPanel from "@/features/workspace/retry-panel";
import { routeData } from "@/features/workspace/route-data";
import { workspace } from "@/features/workspace/server";

export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const project = routeData(await workspace.getProject({ projectId }));
  if (!project) return <RetryPanel />;
  return (
    <div className="page-content narrow-page">
      <Breadcrumbs project={project} current="Edit project" />
      <header className="page-heading">
        <div>
          <h1>Edit project</h1>
        </div>
      </header>
      <ProjectForm key={project.id} initial={project} />
    </div>
  );
}
