import { Breadcrumbs } from "@/features/workspace/feedback";
import NoteEditor from "@/features/workspace/note-editor";
import RetryPanel from "@/features/workspace/retry-panel";
import { routeData } from "@/features/workspace/route-data";
import { workspace } from "@/features/workspace/server";

export default async function NewNotePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const project = routeData(await workspace.getProject({ projectId }));
  if (!project) return <RetryPanel />;
  return (
    <div className="page-content editor-page">
      <Breadcrumbs project={project} current="New note" />
      <header className="page-heading">
        <div>
          <h1>New note</h1>
          <p>A discussion, a decision, a thought worth keeping.</p>
        </div>
      </header>
      <NoteEditor key={`new-${project.id}`} projectId={project.id} />
    </div>
  );
}
