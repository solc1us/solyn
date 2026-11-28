CREATE TABLE "management_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source_message_id" uuid NOT NULL CONSTRAINT "management_proposals_source_message_unique" UNIQUE,
	"kind" text NOT NULL,
	"draft" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "management_proposals_kind_valid" CHECK ("kind" in ('create_project', 'create_tasks', 'update_task')),
	CONSTRAINT "management_proposals_status_valid" CHECK ("status" in ('proposed', 'confirmed')),
	CONSTRAINT "management_proposals_draft_envelope" CHECK (jsonb_typeof("draft") = 'object' and coalesce("draft"->'schemaVersion' = '1'::jsonb, false) and coalesce("draft"->'kind' = to_jsonb("kind"), false)),
	CONSTRAINT "management_proposals_receipt_consistent" CHECK (("status" = 'proposed' and "receipt" is null and "confirmed_at" is null) or ("status" = 'confirmed' and "receipt" is not null and "confirmed_at" is not null and jsonb_typeof("receipt") = 'object' and coalesce("receipt"->'schemaVersion' = '1'::jsonb, false) and coalesce("receipt"->'kind' = to_jsonb("kind"), false))),
	CONSTRAINT "management_proposals_json_size" CHECK (octet_length("draft"::text) <= 131072 and ("receipt" is null or octet_length("receipt"::text) <= 131072))
);
--> statement-breakpoint
ALTER TABLE "management_proposals" ADD CONSTRAINT "management_proposals_source_message_fk" FOREIGN KEY ("source_message_id") REFERENCES "chat_messages"("id") ON DELETE RESTRICT;