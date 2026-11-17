import "server-only";

import { notFound, redirect } from "next/navigation";

import type { WorkspaceResult } from "./contracts";

// Routing presentation only; domain authorization remains in Phase 1D.
export function routeData<T>(result: WorkspaceResult<T>): T | null {
  if (result.ok) return result.data;
  if (result.error.code === "UNAUTHENTICATED") redirect("/login");
  if (result.error.code === "NOT_FOUND" || result.error.code === "INVALID_INPUT") notFound();
  return null;
}
