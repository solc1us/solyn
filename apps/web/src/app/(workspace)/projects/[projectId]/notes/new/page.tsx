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
    <div className="page-content editor-page px-[24px] pt-[20px] pb-[40px] [@media(max-width:760px)]:[padding:20px_max(16px,env(safe-area-inset-right))_max(40px,env(safe-area-inset-bottom))_max(16px,env(safe-area-inset-left))]">
      <Breadcrumbs project={project} current="New note" />
      <header className="page-heading -mx-[24px] mb-[20px] flex min-h-[40px] items-center justify-between gap-[16px] border-b border-border px-[24px] pb-[16px] [@media(min-width:761px)]:sticky [@media(min-width:761px)]:top-0 [@media(min-width:761px)]:z-10 [@media(min-width:761px)]:-mt-[20px] [@media(min-width:761px)]:bg-canvas [@media(min-width:761px)]:pt-[20px] [@media(max-width:1100px)]:flex-wrap [@media(max-width:760px)]:mx-0 [@media(max-width:760px)]:mb-[16px] [@media(max-width:760px)]:gap-[12px] [@media(max-width:760px)]:px-0">
        <div className="min-w-0">
          <h1 className="text-[16px] tracking-[-0.015em]">New note</h1>
        </div>
      </header>
      <NoteEditor key={`new-${project.id}`} projectId={project.id} />
    </div>
  );
}
