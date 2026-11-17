import { defineRelations } from "drizzle-orm";

import * as schema from "./schema";

const workspaceRelations = defineRelations(schema, (r) => ({
  user: {
    projects: r.many.projects({ from: r.user.id, to: r.projects.ownerId }),
  },
  projects: {
    owner: r.one.user({ from: r.projects.ownerId, to: r.user.id }),
    notes: r.many.notes({ from: r.projects.id, to: r.notes.projectId }),
  },
  notes: {
    project: r.one.projects({ from: r.notes.projectId, to: r.projects.id }),
    revisions: r.many.noteRevisions({ from: r.notes.id, to: r.noteRevisions.noteId }),
  },
  noteRevisions: {
    note: r.one.notes({ from: r.noteRevisions.noteId, to: r.notes.id }),
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
