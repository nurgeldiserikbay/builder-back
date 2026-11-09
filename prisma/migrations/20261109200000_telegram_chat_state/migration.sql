-- Context for stage work in the Telegram bot. Holds no message content; cleared when the account is unlinked.
CREATE TABLE "telegram_chat_states" (
  "chat_id" VARCHAR(64) NOT NULL,
  "user_id" UUID NOT NULL,
  "project_id" UUID,
  "stage_key" VARCHAR(40),
  "pending" VARCHAR(40),
  "pending_until" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "telegram_chat_states_pkey" PRIMARY KEY ("chat_id")
);
CREATE INDEX "telegram_chat_states_user_idx" ON "telegram_chat_states"("user_id");
ALTER TABLE "telegram_chat_states" ADD CONSTRAINT "telegram_chat_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telegram_chat_states" ADD CONSTRAINT "telegram_chat_states_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
