import { headers } from "next/headers";
import { redirect } from "next/navigation";

import WorkspaceShell from "@/components/workspace-shell";
import { auth } from "@/services";
import { chat } from "@/features/chat/server";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) redirect("/login");
  // Chat schema may not be installed yet. Its unavailable history must not
  // prevent existing project/note workflows from rendering.
  const recent = await chat.listConversations({ limit: 5 });
  return (
    <WorkspaceShell
      key={session.user.id}
      name={session.user.name}
      email={session.user.email}
      recentConversations={recent.ok ? recent.data : []}
    >
      {children}
    </WorkspaceShell>
  );
}
