import { headers } from "next/headers";
import { redirect } from "next/navigation";

import WorkspaceShell from "@/components/workspace-shell";
import { auth } from "@/services";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  return (
    <WorkspaceShell name={session.user.name} email={session.user.email}>
      {children}
    </WorkspaceShell>
  );
}
