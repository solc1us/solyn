"use server";

import { revalidatePath } from "next/cache";

import { workspace } from "../workspace/server";
import { chat } from "./server";
import type { ChatResult } from "./contracts";

type View = Extract<Awaited<ReturnType<typeof chat.getConversation>>, { ok: true }>["data"] & {
  project: { id: string; name: string } | null;
};

// Only these authenticated operations are client-callable. Assistant response
// writes and recovery remain internal; the stream endpoint owns inference.
export async function createConversation(input: unknown) {
  return chat.createConversation(input);
}
export async function renameConversation(input: unknown) {
  const result = await chat.renameConversation(input);
  if (result.ok) revalidatePath("/chat");
  return result;
}
export async function deleteConversation(input: unknown) {
  const result = await chat.deleteConversation(input);
  if (result.ok) revalidatePath("/chat");
  return result;
}
export async function listConversations(input: unknown = {}) {
  return chat.listConversations(input);
}
export async function getManagementProposal(input: unknown) {
  return chat.getManagementProposal(input);
}
export async function getNoteProposal(input: unknown) {
  return chat.getNoteProposal(input);
}
export async function listProposalProjects(input: unknown = {}) {
  const result = await workspace.listProjects(input);
  return result.ok
    ? { ok: true as const, data: result.data.map(({ id, name }) => ({ id, name })) }
    : result;
}
export async function getConversation(input: unknown): Promise<ChatResult<View>> {
  const result = await chat.getConversation(input);
  if (!result.ok) return result;
  const projectId = result.data.conversation.projectId;
  if (!projectId) return { ...result, data: { ...result.data, project: null } };
  const project = await workspace.getProject({ projectId });
  if (!project.ok) return project;
  return {
    ...result,
    data: { ...result.data, project: { id: project.data.id, name: project.data.name } },
  };
}
