import type { ZodError } from "zod";

import type { getNote, getProject, listNotes } from "./actions";
import type { ErrorCode } from "./contracts";

export type Project = Extract<Awaited<ReturnType<typeof getProject>>, { ok: true }>["data"];
export type Note = Extract<Awaited<ReturnType<typeof getNote>>, { ok: true }>["data"];
export type NoteSummary = Extract<
  Awaited<ReturnType<typeof listNotes>>,
  { ok: true }
>["data"][number];
export type FieldErrors = Record<string, string>;
export type CollectionRow = {
  id: string;
  title: string;
  description?: string | null;
  noteDate?: string | null;
  updatedAt: Date;
};
export const projectRow = (project: Project): CollectionRow => ({
  id: project.id,
  title: project.name,
  description: project.description,
  updatedAt: project.updatedAt,
});
export const noteRow = (note: NoteSummary): CollectionRow => ({
  id: note.id,
  title: note.title,
  noteDate: note.noteDate,
  updatedAt: note.updatedAt,
});

export function fieldErrors(error: ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    errors[field] ??= issue.message;
  }
  return errors;
}

export function errorMessage(code: ErrorCode): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Your session has ended. Sign in in another tab, then return here. Your draft is still here.";
    case "INVALID_INPUT":
      return "Some fields could not be accepted. Review the form and try again.";
    case "NOT_FOUND":
      return "This item is no longer available, or you do not have access to it.";
    case "CONFLICT":
      return "This note changed elsewhere. Your unsaved draft has not been replaced.";
    case "UNAVAILABLE":
      return "We could not confirm the save. Check the latest saved version before trying again. Your draft is still here.";
  }
}

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
export function formatDate(value: Date | string) {
  return dateFormat.format(
    new Date(typeof value === "string" && value.length === 10 ? `${value}T00:00:00Z` : value),
  );
}
export function listKey(rows: { id: string; updatedAt: Date }[]) {
  return rows.map((row) => `${row.id}:${new Date(row.updatedAt).toISOString()}`).join(",");
}
export function appendUnique<T extends { id: string }>(rows: T[], page: T[]) {
  const seen = new Set(rows.map((row) => row.id));
  return [...rows, ...page.filter((row) => !seen.has(row.id) && !!seen.add(row.id))];
}
