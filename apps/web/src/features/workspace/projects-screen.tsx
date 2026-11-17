import { Plus } from "lucide-react";
import Link from "next/link";

import Collection from "./collection";
import { listKey, projectRow } from "./presentation";
import RetryPanel from "./retry-panel";
import { routeData } from "./route-data";
import { workspace } from "./server";

export default async function ProjectsScreen({ home = false }: { home?: boolean }) {
  const projects = routeData(await workspace.listProjects({ limit: 50, offset: 0 }));
  if (!projects) return <RetryPanel />;
  return (
    <div className="page-content">
      <header className="page-heading">
        <div>
          <h1>{home ? "Your workspace" : "Projects"}</h1>
          <p>
            {home
              ? "A little space to keep the whole picture."
              : "The context, decisions, and notes for everything you’re working on."}
          </p>
        </div>
        <Link href="/projects/new" className="primary-link">
          <Plus size={17} aria-hidden="true" />
          New project
        </Link>
      </header>
      {home ? (
        <div className="section-heading">
          <h2>Your projects</h2>
          <span>Private to your account</span>
        </div>
      ) : null}
      <Collection key={listKey(projects)} initial={projects.map(projectRow)} />
      <p className="workspace-footnote">A place for the details you’ll want to remember.</p>
    </div>
  );
}
