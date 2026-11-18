import { notFound } from "next/navigation";
import { z } from "zod";

import { getConversation } from "@/features/chat/actions";
import ChatScreen from "@/features/chat/chat-screen";
import { routeData } from "@/features/workspace/route-data";
import RetryPanel from "@/features/workspace/retry-panel";
import { workspace } from "@/features/workspace/server";

const queryInput = z
  .strictObject({
    conversationId: z
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
    projectId: z
      .uuid()
      .transform((id) => id.toLowerCase())
      .optional(),
  })
  .refine((value) => !value.conversationId || !value.projectId);

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = queryInput.safeParse(await searchParams);
  if (!query.success) notFound();
  const { conversationId, projectId } = query.data;
  if (conversationId) {
    const initial = await getConversation({ conversationId, latest: true, limit: 50 });
    return <ChatScreen conversationId={conversationId} project={null} initial={initial} />;
  }
  if (projectId) {
    const project = routeData(await workspace.getProject({ projectId }));
    if (!project) return <RetryPanel />;
    return <ChatScreen project={{ id: project.id, name: project.name }} />;
  }
  return <ChatScreen project={null} />;
}
