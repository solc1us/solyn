import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";
import { projects } from "./workspace";

export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check("chat_conversations_title_nonblank", sql`${table.title} ~ '[^[:space:]]'`),
    index("chat_conversations_owner_updated_idx").on(
      table.ownerId,
      table.updatedAt.desc(),
      table.id.desc(),
    ),
  ],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversations.id, { onDelete: "restrict" }),
    turnId: uuid("turn_id").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    status: text("status", { enum: ["pending", "completed", "failed", "stopped"] }).notNull(),
    modelId: text("model_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    unique("chat_messages_turn_role_unique").on(table.conversationId, table.turnId, table.role),
    check("chat_messages_role_valid", sql`${table.role} in ('user', 'assistant')`),
    check(
      "chat_messages_status_valid",
      sql`${table.status} in ('pending', 'completed', 'failed', 'stopped')`,
    ),
    check(
      "chat_messages_user_consistent",
      sql`${table.role} <> 'user' or (${table.status} = 'completed' and ${table.modelId} is null)`,
    ),
    // Defense in depth alongside the service's conversation-row lock protocol.
    uniqueIndex("chat_messages_one_pending_idx")
      .on(table.conversationId)
      .where(sql`${table.status} = 'pending'`),
    index("chat_messages_conversation_order_idx").on(
      table.conversationId,
      table.createdAt,
      table.role.desc(),
      table.id,
    ),
  ],
);
