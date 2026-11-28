import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { chatMessages } from "./chat";

// Ownership/scope derive from the immutable source conversation. Result IDs live
// only in validated JSON receipts: they must not block permanent task deletion.
export const managementProposals = pgTable(
  "management_proposals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceMessageId: uuid("source_message_id").notNull(),
    kind: text("kind", { enum: ["create_project", "create_tasks", "update_task"] }).notNull(),
    draft: jsonb("draft").notNull(),
    status: text("status", { enum: ["proposed", "confirmed"] })
      .default("proposed")
      .notNull(),
    receipt: jsonb("receipt"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    unique("management_proposals_source_message_unique").on(table.sourceMessageId),
    foreignKey({
      name: "management_proposals_source_message_fk",
      columns: [table.sourceMessageId],
      foreignColumns: [chatMessages.id],
    })
      .onDelete("restrict")
      .onUpdate("no action"),
    check(
      "management_proposals_kind_valid",
      sql`${table.kind} in ('create_project', 'create_tasks', 'update_task')`,
    ),
    check("management_proposals_status_valid", sql`${table.status} in ('proposed', 'confirmed')`),
    check(
      "management_proposals_draft_envelope",
      sql`jsonb_typeof(${table.draft}) = 'object' and coalesce(${table.draft}->'schemaVersion' = '1'::jsonb, false) and coalesce(${table.draft}->'kind' = to_jsonb(${table.kind}), false)`,
    ),
    check(
      "management_proposals_receipt_consistent",
      sql`(${table.status} = 'proposed' and ${table.receipt} is null and ${table.confirmedAt} is null) or (${table.status} = 'confirmed' and ${table.receipt} is not null and ${table.confirmedAt} is not null and jsonb_typeof(${table.receipt}) = 'object' and coalesce(${table.receipt}->'schemaVersion' = '1'::jsonb, false) and coalesce(${table.receipt}->'kind' = to_jsonb(${table.kind}), false))`,
    ),
    check(
      "management_proposals_json_size",
      sql`octet_length(${table.draft}::text) <= 131072 and (${table.receipt} is null or octet_length(${table.receipt}::text) <= 131072)`,
    ),
  ],
);
