-- The project's Telegram group: key events as plain lines, linked by a one-time code.
CREATE TABLE "project_telegram_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "code_hash" VARCHAR(64),
    "code_expires_at" TIMESTAMPTZ(3),
    "chat_id" VARCHAR(64),
    "title" VARCHAR(255),
    "linked_by_user_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ(3),
    "cursor_at" TIMESTAMPTZ(3),
    "cursor_id" UUID,
    "last_sent_at" TIMESTAMPTZ(3),
    "last_failed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_telegram_groups_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "project_telegram_groups_project_id_key" ON "project_telegram_groups"("project_id");
CREATE UNIQUE INDEX "project_telegram_groups_code_hash_key" ON "project_telegram_groups"("code_hash");
CREATE INDEX "project_telegram_groups_chat_idx" ON "project_telegram_groups"("chat_id");
ALTER TABLE "project_telegram_groups" ADD CONSTRAINT "project_telegram_groups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
