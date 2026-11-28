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
    <div className="page-content narrow-page px-[24px] pt-[20px] pb-[40px] [@media(max-width:760px)]:[padding:20px_max(16px,env(safe-area-inset-right))_max(40px,env(safe-area-inset-bottom))_max(16px,env(safe-area-inset-left))]">
      <Breadcrumbs project={project} current="Edit project" />
      <ProjectForm key={project.id} initial={project} />
    </div>
  );
}
