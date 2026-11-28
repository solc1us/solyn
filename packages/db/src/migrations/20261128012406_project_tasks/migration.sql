CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text,
	"assignee" text,
	"due_date" date,
	"source_note_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tasks_title_nonblank" CHECK ("title" ~ '[^[:space:]]'),
	CONSTRAINT "tasks_title_length" CHECK (char_length("title") <= 300),
	CONSTRAINT "tasks_description_length" CHECK (char_length("description") <= 5000),
	CONSTRAINT "tasks_assignee_length" CHECK (char_length("assignee") <= 200),
	CONSTRAINT "tasks_status_valid" CHECK ("status" in ('todo', 'in_progress', 'blocked', 'done')),
	CONSTRAINT "tasks_priority_valid" CHECK ("priority" in ('urgent', 'high', 'medium', 'low')),
	CONSTRAINT "tasks_version_positive" CHECK ("version" > 0),
	CONSTRAINT "tasks_completed_consistent" CHECK (("status" = 'done' and "completed_at" is not null) or ("status" <> 'done' and "completed_at" is null))
);
--> statement-breakpoint
CREATE INDEX "tasks_project_updated_idx" ON "tasks" ("project_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "tasks_project_due_idx" ON "tasks" ("project_id","due_date","id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_note_id_notes_id_fkey" FOREIGN KEY ("source_note_id") REFERENCES "notes"("id") ON DELETE RESTRICT;