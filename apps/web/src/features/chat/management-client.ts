import {
  confirmManagementProposalInput,
  type ManagementConfirmation,
  type ManagementProposalView,
  type managementTaskFields,
} from "./management-contracts";
import type { z } from "zod";
import type { Issue } from "./transport";

export type ManagementItemEdit = {
  itemId: number;
  selected: boolean;
  fields: z.output<typeof managementTaskFields>;
  invalidDate?: boolean;
};
export type ManagementEdit =
  | { kind: "create_project"; name: string; description: string }
  | { kind: "create_tasks"; projectId: string; items: ManagementItemEdit[] };
export type ManagementSave = {
  phase: "saving" | "checking" | "uncertain" | "retry" | "error";
  proposal: ManagementProposalView;
  payload: ManagementConfirmation;
  issue: Issue | null;
};
export function originalManagementEdit(proposal: ManagementProposalView): ManagementEdit {
  const draft = proposal.draft;
  return draft.kind === "create_project"
    ? { kind: draft.kind, name: draft.name, description: draft.description ?? "" }
    : {
        kind: draft.kind,
        projectId: proposal.scopedProject?.id ?? "",
        items: draft.items.map((item) => ({
          itemId: item.itemId,
          selected: true,
          fields: { ...item.fields },
        })),
      };
}
export function managementEditDirty(proposal: ManagementProposalView, edit?: ManagementEdit) {
  return !!edit && JSON.stringify(edit) !== JSON.stringify(originalManagementEdit(proposal));
}
export function managementInput(proposalId: string, edit: ManagementEdit) {
  return edit.kind === "create_project"
    ? { proposalId, kind: edit.kind, name: edit.name, description: edit.description || null }
    : {
        proposalId,
        kind: edit.kind,
        projectId: edit.projectId,
        items: edit.items
          .filter((i) => i.selected)
          .map(({ itemId, fields }) => ({ itemId, fields })),
      };
}
export function managementCompatible(proposal: ManagementProposalView, edit: ManagementEdit) {
  if (proposal.kind !== edit.kind || proposal.status !== "proposed") return false;
  if (edit.kind === "create_project") return proposal.scopedProject === null;
  if (
    proposal.draft.kind !== "create_tasks" ||
    (proposal.scopedProject && edit.projectId !== proposal.scopedProject.id)
  )
    return false;
  const originals = proposal.draft.items;
  return (
    edit.items.length === originals.length &&
    edit.items.every((item, index) => {
      const original = originals[index];
      if (!original || original.itemId !== item.itemId) return false;
      if (!item.selected) return true;
      if (item.invalidDate) return false;
      if (original.evidence.type === "user_message") return item.fields.sourceNoteId === null;
      const source = original.evidence.source;
      return (
        source.state === "available" &&
        source.projectId === edit.projectId &&
        source.updatedAt === source.retrievedUpdatedAt &&
        (item.fields.sourceNoteId === null || item.fields.sourceNoteId === source.noteId)
      );
    })
  );
}
export function managementPayload(
  proposal: ManagementProposalView,
  edit: ManagementEdit,
): ManagementConfirmation | null {
  if (!managementCompatible(proposal, edit)) return null;
  const parsed = confirmManagementProposalInput.safeParse(managementInput(proposal.id, edit));
  return parsed.success ? parsed.data : null;
}
export function compatibleManagementReceipt(a: ManagementProposalView, b: ManagementProposalView) {
  if (
    a.id !== b.id ||
    a.kind !== b.kind ||
    a.sourceMessageId !== b.sourceMessageId ||
    a.conversationId !== b.conversationId ||
    a.turnId !== b.turnId ||
    (a.scopedProject?.id ?? null) !== (b.scopedProject?.id ?? null)
  )
    return false;
  const x = a.receipt,
    y = b.receipt;
  if (!x || !y) return true;
  if (x.kind === "create_project" && y.kind === "create_project")
    return (
      x.result.state !== "available" ||
      y.result.state !== "available" ||
      x.result.projectId === y.result.projectId
    );
  if (
    x.kind !== "create_tasks" ||
    y.kind !== "create_tasks" ||
    x.results.length !== y.results.length
  )
    return false;
  return x.results.every((r, i) => {
    const s = y.results[i]!;
    return (
      r.itemId === s.itemId &&
      (r.state !== "available" ||
        s.state !== "available" ||
        (r.taskId === s.taskId && r.projectId === s.projectId))
    );
  });
}
// Confirmation is durable; source/result availability is not. Cached projections
// must be stripped before view activation, stale callbacks or failed reads.
export function revokeManagement(proposal: ManagementProposalView): ManagementProposalView {
  return {
    ...proposal,
    draft:
      proposal.draft.kind === "create_tasks"
        ? {
            ...proposal.draft,
            items: proposal.draft.items.map((item) =>
              item.evidence.type === "retrieved_note"
                ? {
                    ...item,
                    fields: { ...item.fields, sourceNoteId: null },
                    evidence: {
                      type: "retrieved_note",
                      excerptOnly: true,
                      source: { state: "unavailable" },
                    },
                  }
                : item,
            ),
          }
        : proposal.draft,
    receipt:
      proposal.receipt?.kind === "create_project"
        ? { kind: "create_project", result: { state: "unavailable" } }
        : proposal.receipt?.kind === "create_tasks"
          ? {
              kind: "create_tasks",
              results: proposal.receipt.results.map((r) => ({
                itemId: r.itemId,
                state: "unavailable",
              })),
            }
          : null,
  };
}
