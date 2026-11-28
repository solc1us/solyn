import { buttonVariants } from "@solyn/ui/components/button";
import { cn } from "@solyn/ui/lib/utils";
import { Plus } from "lucide-react";
import Link from "next/link";

import Collection from "./collection";
import { listKey, projectRow } from "./presentation";
import RetryPanel from "./retry-panel";
import { routeData } from "./route-data";
import { workspace } from "./server";
import { getTaskSummary } from "./actions";
import WorkspaceSummary from "./workspace-summary";

export default async function ProjectsScreen({ home = false }: { home?: boolean }) {
  const projects = routeData(await workspace.listProjects({ limit: 50, offset: 0 }));
  if (!projects && !home) return <RetryPanel />;
  return (
    <div className="page-content px-[24px] pt-[20px] pb-[40px] [@media(max-width:760px)]:[padding:20px_max(16px,env(safe-area-inset-right))_max(40px,env(safe-area-inset-bottom))_max(16px,env(safe-area-inset-left))]">
      <header className="page-heading -mx-[24px] mb-[20px] flex min-h-[40px] items-center justify-between gap-[16px] border-b border-border px-[24px] pb-[16px] [@media(min-width:761px)]:sticky [@media(min-width:761px)]:top-0 [@media(min-width:761px)]:z-10 [@media(min-width:761px)]:-mt-[20px] [@media(min-width:761px)]:bg-canvas [@media(min-width:761px)]:pt-[20px] [@media(max-width:1100px)]:flex-wrap [@media(max-width:760px)]:mx-0 [@media(max-width:760px)]:mb-[16px] [@media(max-width:760px)]:gap-[12px] [@media(max-width:760px)]:px-0">
        <div className="min-w-0">
          <h1 className="text-[16px] tracking-[-0.015em]">{home ? "Workspace" : "Projects"}</h1>
        </div>
        <Link href="/projects/new" className={cn(buttonVariants(), "bg-clip-border select-auto")}>
          <Plus size={17} className="size-[17px]" aria-hidden="true" />
          New project
        </Link>
      </header>
      {home ? (
        <>
          {/* Successful mutation revalidation produces a new RSC generation. Remount
            the local-date reader instead of keeping a stale client-only summary. */}
          <WorkspaceSummary key={crypto.randomUUID()} read={getTaskSummary} />
          <h2 className="mb-[8px] text-[14px] font-[550]">Projects</h2>
        </>
      ) : null}
      {projects ? (
        <Collection key={listKey(projects)} initial={projects.map(projectRow)} />
      ) : (
        <RetryPanel />
      )}
    </div>
  );
}
