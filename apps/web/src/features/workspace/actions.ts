"use server";

import { revalidatePath } from "next/cache";

import { workspace } from "./server";

function refreshProjectViews(projectId: string, taskId?: string) {
  revalidatePath("/dashboard");
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  if (taskId) {
    revalidatePath("/tasks");
    revalidatePath(`/tasks/${taskId}`);
  }
}

// Thin transport adapters. Server Components and future server-side tools can
// call the same authenticated domain operations through server.ts directly.
// Revalidate only after the domain operation confirms a successful write.
export async function listProjects(input: unknown = {}) {
  return workspace.listProjects(input);
}
export async function getProject(input: unknown) {
  return workspace.getProject(input);
}
export async function createProject(input: unknown) {
  const result = await workspace.createProject(input);
  if (result.ok) refreshProjectViews(result.data.id);
  return result;
}
export async function updateProject(input: unknown) {
  const result = await workspace.updateProject(input);
  if (result.ok) {
    refreshProjectViews(result.data.id);
    revalidatePath(`/projects/${result.data.id}/edit`);
  }
  return result;
}
export async function createTask(input: unknown) {
  const result = await workspace.createTask(input);
  if (result.ok) refreshProjectViews(result.data.projectId, result.data.id);
  return result;
}
export async function getTask(input: unknown) {
  return workspace.getTask(input);
}
export async function listTasks(input: unknown) {
  return workspace.listTasks(input);
}
export async function listOwnedTasks(input: unknown = {}) {
  return workspace.listOwnedTasks(input);
}
export async function updateTask(input: unknown) {
  const result = await workspace.updateTask(input);
  if (result.ok) refreshProjectViews(result.data.projectId, result.data.id);
  return result;
}
export async function deleteTask(input: unknown) {
  const result = await workspace.deleteTask(input);
  if (result.ok) refreshProjectViews(result.data.projectId, result.data.id);
  return result;
}
export async function listNotes(input: unknown) {
  return workspace.listNotes(input);
}
export async function searchNotes(input: unknown) {
  return workspace.searchNotes(input);
}
export async function getNote(input: unknown) {
  return workspace.getNote(input);
}
export async function createNote(input: unknown) {
  const result = await workspace.createNote(input);
  if (result.ok) {
    refreshProjectViews(result.data.projectId);
    revalidatePath(`/projects/${result.data.projectId}/notes/${result.data.id}`);
  }
  return result;
}
export async function confirmManagementProposal(input: unknown) {
  const result = await workspace.confirmManagementProposal(input);
  if (result.ok) {
    revalidatePath("/dashboard");
    revalidatePath("/projects");
    revalidatePath("/tasks");
    const receipt = result.data.proposal.receipt;
    if (receipt?.kind === "create_project" && receipt.result.state === "available")
      revalidatePath(receipt.result.href);
    if (receipt?.kind === "update_task" && receipt.result.state === "available") {
      revalidatePath(`/projects/${receipt.result.projectId}`);
      revalidatePath(receipt.result.href);
    }
    if (receipt?.kind === "create_tasks")
      for (const task of receipt.results) {
        if (task.state === "available") {
          revalidatePath(`/projects/${task.projectId}`);
          revalidatePath(task.href);
        }
      }
  }
  return result;
}
export async function confirmNoteProposal(input: unknown) {
  const result = await workspace.confirmNoteProposal(input);
  if (result.ok) {
    refreshProjectViews(result.data.projectId);
    revalidatePath(result.data.href);
  }
  return result;
}
export async function updateNote(input: unknown) {
  const result = await workspace.updateNote(input);
  if (result.ok) {
    refreshProjectViews(result.data.projectId);
    revalidatePath(`/projects/${result.data.projectId}/notes/${result.data.id}`);
  }
  return result;
}
