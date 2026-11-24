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
    <div className="page-content editor-page px-[24px] pt-[20px] pb-[40px] [@media(max-width:760px)]:[padding:20px_max(16px,env(safe-area-inset-right))_max(40px,env(safe-area-inset-bottom))_max(16px,env(safe-area-inset-left))]">
      <Breadcrumbs project={project} current="Note" />
      <NoteEditor key={note.id} projectId={project.id} initial={note} />
    </div>
  );
}
