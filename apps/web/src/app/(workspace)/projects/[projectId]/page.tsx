import { buttonVariants } from "@solyn/ui/components/button";
import { cn } from "@solyn/ui/lib/utils";
import { Plus, Pencil } from "lucide-react";
import Link from "next/link";

import ProjectChatPopup from "@/features/chat/project-chat-popup";
import { searchNotes } from "@/features/workspace/actions";
import Collection from "@/features/workspace/collection";
import NoteSearch from "@/features/workspace/note-search";
import { Breadcrumbs } from "@/features/workspace/feedback";
import { formatDate, listKey, noteRow } from "@/features/workspace/presentation";
import RetryPanel from "@/features/workspace/retry-panel";
import { routeData } from "@/features/workspace/route-data";
import { workspace } from "@/features/workspace/server";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const [projectResult, notesResult] = await Promise.all([
    workspace.getProject({ projectId }),
    workspace.listNotes({ projectId, limit: 50, offset: 0 }),
  ]);
  const project = routeData(projectResult);
  const notes = routeData(notesResult);
  if (!project || !notes) return <RetryPanel />;
  return (
    <div className="page-content px-[24px] pt-[20px] pb-[40px] [@media(max-width:760px)]:[padding:20px_max(16px,env(safe-area-inset-right))_max(40px,env(safe-area-inset-bottom))_max(16px,env(safe-area-inset-left))]">
      <Breadcrumbs current={project.name} />
      <header className="page-heading -mx-[24px] mb-[20px] flex min-h-[40px] items-center justify-between gap-[16px] border-b border-border px-[24px] pb-[16px] [@media(min-width:761px)]:sticky [@media(min-width:761px)]:top-0 [@media(min-width:761px)]:z-10 [@media(min-width:761px)]:-mt-[20px] [@media(min-width:761px)]:bg-canvas [@media(min-width:761px)]:pt-[20px] [@media(max-width:1100px)]:flex-wrap [@media(max-width:760px)]:mx-0 [@media(max-width:760px)]:mb-[16px] [@media(max-width:760px)]:gap-[12px] [@media(max-width:760px)]:px-0">
        <div className="min-w-0">
          <h1 className="text-[16px] tracking-[-0.015em]">{project.name}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-[8px]">
          <ProjectChatPopup project={{ id: project.id, name: project.name }} />
          <Link
            href={`/projects/${project.id}/edit`}
            className={cn(buttonVariants(), "bg-clip-border select-auto")}
          >
            <Pencil size={15} className="size-[15px]" aria-hidden="true" />
            Edit project
          </Link>
          <Link
            href={`/projects/${project.id}/notes/new`}
            className={cn(buttonVariants(), "bg-clip-border select-auto")}
          >
            <Plus size={17} className="size-[17px]" aria-hidden="true" />
            New note
          </Link>
        </div>
      </header>
      <div className="project-summary">
        {project.description ? (
          <p className="project-description mt-[8px] max-w-[64ch] leading-[1.6] whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
            {project.description}
          </p>
        ) : null}
        <p className="metadata mt-[16px] max-w-[64ch] text-[12px] leading-[1.6] text-muted-foreground">
          Created {formatDate(project.createdAt)}
        </p>
      </div>
      <div className="section-heading mt-[24px] mb-[12px] flex flex-wrap items-baseline justify-between gap-[12px]">
        <h2 className="text-[14px]">Notes</h2>
      </div>
      <NoteSearch
        key={`${project.id}:${listKey(notes)}`}
        projectId={project.id}
        searchAction={searchNotes}
      >
        <Collection key={listKey(notes)} projectId={project.id} initial={notes.map(noteRow)} />
      </NoteSearch>
    </div>
  );
}
