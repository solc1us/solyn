import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { user } from "./auth";

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check("projects_name_nonblank", sql`${table.name} ~ '[^[:space:]]'`),
    index("projects_owner_updated_idx").on(table.ownerId, table.updatedAt),
  ],
);

export const notes = pgTable(
  "notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    noteDate: date("note_date", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check("notes_title_nonblank", sql`${table.title} ~ '[^[:space:]]'`),
    index("notes_project_updated_idx").on(table.projectId, table.updatedAt),
  ],
);

// Initial current state is version 1 and has no snapshot. Before meaningful edit N,
// save the outgoing state as version N, then update notes in the same transaction.
// Current version = max(snapshot version) + 1; lock the note when allocating versions.
export const noteRevisions = pgTable(
  "note_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    noteDate: date("note_date", { mode: "string" }),
    // Time this outgoing version was archived, not the note's original creation time.
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("note_revisions_note_version_unique").on(table.noteId, table.version),
    check("note_revisions_version_positive", sql`${table.version} > 0`),
    check("note_revisions_title_nonblank", sql`${table.title} ~ '[^[:space:]]'`),
  ],
);
