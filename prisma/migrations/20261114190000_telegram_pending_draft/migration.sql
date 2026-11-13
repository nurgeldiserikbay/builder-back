-- A remark typed in Telegram waits here while the person picks whom to mention.
ALTER TABLE "telegram_chat_states" ADD COLUMN "pending_draft" JSONB;
