-- Voice messages in the bot: consent per account and the recognised text waiting for confirmation.
ALTER TABLE "users" ADD COLUMN "voice_consent_at" TIMESTAMPTZ(3);
ALTER TABLE "telegram_chat_states" ADD COLUMN "pending_text" VARCHAR(1000);
