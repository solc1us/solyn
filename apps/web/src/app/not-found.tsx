import { buttonVariants } from "@solyn/ui/components/button";
import { cn } from "@solyn/ui/lib/utils";
import Link from "next/link";

export default function NotFound() {
  return (
    <main className="standalone-page mx-auto w-[min(740px,100%)] px-[24px] py-[12vh]">
      <section className="status-panel rounded-[12px] border border-border bg-canvas p-[40px] [.workspace-main_&]:rounded-none [.workspace-main_&]:border-0 [.workspace-main_&]:bg-transparent [@media(max-width:760px)]:px-[22px] [@media(max-width:760px)]:py-[28px]">
        <h1>Nothing here</h1>
        <p className="mt-[16px] mb-[26px] text-muted-foreground">
          This page does not exist, or the item is not available to your account.
        </p>
        <Link href="/dashboard" className={cn(buttonVariants(), "bg-clip-border select-auto")}>
          Back to workspace
        </Link>
      </section>
    </main>
  );
}
