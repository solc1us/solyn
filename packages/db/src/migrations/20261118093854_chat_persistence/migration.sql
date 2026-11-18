CREATE TABLE "chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"owner_id" text NOT NULL,
	"project_id" uuid,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_conversations_title_nonblank" CHECK ("title" ~ '[^[:space:]]')
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"conversation_id" uuid NOT NULL,
	"turn_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"status" text NOT NULL,
	"model_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_turn_role_unique" UNIQUE("conversation_id","turn_id","role"),
	CONSTRAINT "chat_messages_role_valid" CHECK ("role" in ('user', 'assistant')),
	CONSTRAINT "chat_messages_status_valid" CHECK ("status" in ('pending', 'completed', 'failed', 'stopped')),
	CONSTRAINT "chat_messages_user_consistent" CHECK ("role" <> 'user' or ("status" = 'completed' and "model_id" is null))
);
--> statement-breakpoint
CREATE INDEX "chat_conversations_owner_updated_idx" ON "chat_conversations" ("owner_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_one_pending_idx" ON "chat_messages" ("conversation_id") WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX "chat_messages_conversation_order_idx" ON "chat_messages" ("conversation_id","created_at","role" DESC NULLS LAST,"id");--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_owner_id_user_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_chat_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations"("id") ON DELETE RESTRICT;