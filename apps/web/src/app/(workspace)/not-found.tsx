import { buttonVariants } from "@solyn/ui/components/button";
import { cn } from "@solyn/ui/lib/utils";
import Link from "next/link";

export default function WorkspaceNotFound() {
  return (
    <div className="page-content px-[24px] pt-[20px] pb-[40px] [@media(max-width:760px)]:[padding:20px_max(16px,env(safe-area-inset-right))_max(40px,env(safe-area-inset-bottom))_max(16px,env(safe-area-inset-left))]">
      <section className="status-panel rounded-[12px] border border-border bg-canvas p-[40px] [.workspace-main_&]:rounded-none [.workspace-main_&]:border-0 [.workspace-main_&]:bg-transparent [@media(max-width:760px)]:px-[22px] [@media(max-width:760px)]:py-[28px]">
        <h1>Nothing here</h1>
        <p className="mt-[16px] mb-[26px] text-muted-foreground">
          This item does not exist, or it is not available to your account.
        </p>
        <Link href="/projects" className={cn(buttonVariants(), "bg-clip-border select-auto")}>
          Back to projects
        </Link>
      </section>
    </div>
  );
}
