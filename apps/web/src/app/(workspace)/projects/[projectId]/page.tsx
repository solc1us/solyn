import { Plus, Pencil } from "lucide-react";
import Link from "next/link";

import Collection from "@/features/workspace/collection";
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
    <div className="page-content">
      <Breadcrumbs current={project.name} />
      <header className="page-heading">
        <div>
          <h1>{project.name}</h1>
          {project.description ? (
            <p className="project-description">{project.description}</p>
          ) : null}
          <p className="metadata">Created {formatDate(project.createdAt)}</p>
        </div>
        <div className="inline-actions">
          <Link href={`/projects/${project.id}/edit`} className="secondary-link">
            <Pencil size={15} aria-hidden="true" />
            Edit project
          </Link>
          <Link href={`/projects/${project.id}/notes/new`} className="primary-link">
            <Plus size={17} aria-hidden="true" />
            New note
          </Link>
        </div>
      </header>
      <div className="section-heading">
        <h2>Notes</h2>
      </div>
      <Collection key={listKey(notes)} projectId={project.id} initial={notes.map(noteRow)} />
    </div>
  );
}
