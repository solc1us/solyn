import { sql } from "drizzle-orm";
import { check, date, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { chatMessages } from "./chat";
import { notes, projects } from "./workspace";

// Owner, conversation, turn and original project scope come from the source
// assistant message and its immutable conversation. No parallel owner identity.
// Service checks must enforce assistant/completed source, ownership, immutable
// draft/receipt and the atomic proposed -> confirmed + note insert protocol.
export const noteProposals = pgTable(
  "note_proposals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceMessageId: uuid("source_message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "restrict" }),
    projectHint: text("project_hint"),
    title: text("title").notNull(),
    content: text("content").notNull(),
    noteDate: date("note_date", { mode: "string" }),
    status: text("status", { enum: ["proposed", "confirmed"] })
      .default("proposed")
      .notNull(),
    noteId: uuid("note_id").references(() => notes.id, { onDelete: "restrict" }),
    approvedProjectId: uuid("approved_project_id").references(() => projects.id, {
      onDelete: "restrict",
    }),
    approvedTitle: text("approved_title"),
    approvedContent: text("approved_content"),
    approvedNoteDate: date("approved_note_date", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    unique("note_proposals_source_message_unique").on(table.sourceMessageId),
    check(
      "note_proposals_draft_nonblank",
      sql`${table.title} ~ '[^[:space:]]' and ${table.content} ~ '[^[:space:]]'`,
    ),
    check(
      "note_proposals_approved_nonblank",
      sql`(${table.approvedTitle} is null or ${table.approvedTitle} ~ '[^[:space:]]') and (${table.approvedContent} is null or ${table.approvedContent} ~ '[^[:space:]]')`,
    ),
    check(
      "note_proposals_receipt_consistent",
      sql`(${table.status} = 'proposed' and ${table.noteId} is null and ${table.approvedProjectId} is null and ${table.approvedTitle} is null and ${table.approvedContent} is null and ${table.approvedNoteDate} is null and ${table.confirmedAt} is null) or (${table.status} = 'confirmed' and ${table.noteId} is not null and ${table.approvedProjectId} is not null and ${table.approvedTitle} is not null and ${table.approvedContent} is not null and ${table.confirmedAt} is not null)`,
    ),
  ],
);
