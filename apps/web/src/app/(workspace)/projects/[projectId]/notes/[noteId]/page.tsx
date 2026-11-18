import { Breadcrumbs } from "@/features/workspace/feedback";
import NoteEditor from "@/features/workspace/note-editor";
import RetryPanel from "@/features/workspace/retry-panel";
import { routeData } from "@/features/workspace/route-data";
import { workspace } from "@/features/workspace/server";

export default async function NotePage({
  params,
}: {
  params: Promise<{ projectId: string; noteId: string }>;
}) {
  const { projectId, noteId } = await params;
  const [projectResult, noteResult] = await Promise.all([
    workspace.getProject({ projectId }),
    workspace.getNote({ projectId, noteId }),
  ]);
  const project = routeData(projectResult);
  const note = routeData(noteResult);
  if (!project || !note) return <RetryPanel />;
  return (
    <div className="page-content editor-page">
      <Breadcrumbs project={project} current="Note" />
      <header className="page-heading">
        <div>
          <h1>Project note</h1>
        </div>
      </header>
      <NoteEditor key={note.id} projectId={project.id} initial={note} />
    </div>
  );
}
