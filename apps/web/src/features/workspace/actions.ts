"use server";

import { workspace } from "./server";

// Thin transport adapters. Server Components and future server-side tools can
// call the same authenticated domain operations through server.ts directly.
// Phase 1E chooses route-specific refresh/revalidation once its routes exist.
export async function listProjects(input: unknown = {}) {
  return workspace.listProjects(input);
}
export async function getProject(input: unknown) {
  return workspace.getProject(input);
}
export async function createProject(input: unknown) {
  return workspace.createProject(input);
}
export async function updateProject(input: unknown) {
  return workspace.updateProject(input);
}
export async function listNotes(input: unknown) {
  return workspace.listNotes(input);
}
export async function getNote(input: unknown) {
  return workspace.getNote(input);
}
export async function createNote(input: unknown) {
  return workspace.createNote(input);
}
export async function updateNote(input: unknown) {
  return workspace.updateNote(input);
}
