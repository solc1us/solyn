ALTER TABLE "chat_messages" ADD COLUMN "source_refs" jsonb;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sources_consistent" CHECK (case
        when "source_refs" is null then true
        when jsonb_typeof("source_refs") = 'array' then
          "role" = 'assistant' and "status" = 'completed'
          and jsonb_array_length("source_refs") between 1 and 5
        else false
      end);