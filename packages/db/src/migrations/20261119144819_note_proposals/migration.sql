CREATE TABLE "note_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_message_id" uuid NOT NULL CONSTRAINT "note_proposals_source_message_unique" UNIQUE,
	"project_hint" text,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"note_date" date,
	"status" text DEFAULT 'proposed' NOT NULL,
	"note_id" uuid,
	"approved_project_id" uuid,
	"approved_title" text,
	"approved_content" text,
	"approved_note_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "note_proposals_draft_nonblank" CHECK ("title" ~ '[^[:space:]]' and "content" ~ '[^[:space:]]'),
	CONSTRAINT "note_proposals_approved_nonblank" CHECK (("approved_title" is null or "approved_title" ~ '[^[:space:]]') and ("approved_content" is null or "approved_content" ~ '[^[:space:]]')),
	CONSTRAINT "note_proposals_receipt_consistent" CHECK (("status" = 'proposed' and "note_id" is null and "approved_project_id" is null and "approved_title" is null and "approved_content" is null and "approved_note_date" is null and "confirmed_at" is null) or ("status" = 'confirmed' and "note_id" is not null and "approved_project_id" is not null and "approved_title" is not null and "approved_content" is not null and "confirmed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "note_proposals" ADD CONSTRAINT "note_proposals_source_message_id_chat_messages_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "chat_messages"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "note_proposals" ADD CONSTRAINT "note_proposals_note_id_notes_id_fkey" FOREIGN KEY ("note_id") REFERENCES "notes"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "note_proposals" ADD CONSTRAINT "note_proposals_approved_project_id_projects_id_fkey" FOREIGN KEY ("approved_project_id") REFERENCES "projects"("id") ON DELETE RESTRICT;