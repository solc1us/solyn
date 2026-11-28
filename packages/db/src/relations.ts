import { defineRelations } from "drizzle-orm";

import * as schema from "./schema";

const workspaceRelations = defineRelations(schema, (r) => ({
  user: {
    projects: r.many.projects({ from: r.user.id, to: r.projects.ownerId }),
    conversations: r.many.chatConversations({ from: r.user.id, to: r.chatConversations.ownerId }),
  },
  projects: {
    owner: r.one.user({ from: r.projects.ownerId, to: r.user.id }),
    notes: r.many.notes({ from: r.projects.id, to: r.notes.projectId }),
    tasks: r.many.tasks({ from: r.projects.id, to: r.tasks.projectId }),
    conversations: r.many.chatConversations({
      from: r.projects.id,
      to: r.chatConversations.projectId,
    }),
  },
  notes: {
    project: r.one.projects({ from: r.notes.projectId, to: r.projects.id }),
    revisions: r.many.noteRevisions({ from: r.notes.id, to: r.noteRevisions.noteId }),
    tasks: r.many.tasks({ from: r.notes.id, to: r.tasks.sourceNoteId }),
  },
  tasks: {
    project: r.one.projects({ from: r.tasks.projectId, to: r.projects.id }),
    sourceNote: r.one.notes({ from: r.tasks.sourceNoteId, to: r.notes.id }),
  },
  noteRevisions: {
    note: r.one.notes({ from: r.noteRevisions.noteId, to: r.notes.id }),
  },
  chatConversations: {
    owner: r.one.user({ from: r.chatConversations.ownerId, to: r.user.id }),
    project: r.one.projects({ from: r.chatConversations.projectId, to: r.projects.id }),
    messages: r.many.chatMessages({
      from: r.chatConversations.id,
      to: r.chatMessages.conversationId,
    }),
  },
  chatMessages: {
    conversation: r.one.chatConversations({
      from: r.chatMessages.conversationId,
      to: r.chatConversations.id,
    }),
    proposal: r.one.noteProposals({
      from: r.chatMessages.id,
      to: r.noteProposals.sourceMessageId,
    }),
  },
  noteProposals: {
    sourceMessage: r.one.chatMessages({
      from: r.noteProposals.sourceMessageId,
      to: r.chatMessages.id,
    }),
    approvedProject: r.one.projects({
      from: r.noteProposals.approvedProjectId,
      to: r.projects.id,
    }),
    note: r.one.notes({ from: r.noteProposals.noteId, to: r.notes.id }),
  },
}));

export const relations = {
  ...workspaceRelations,
  ...schema.authRelations,
  user: {
    ...schema.authRelations.user,
    relations: {
      ...schema.authRelations.user.relations,
      ...workspaceRelations.user.relations,
    },
  },
};
