-- Attachments (stage files) and mentions in stage remarks.
ALTER TABLE "stage_comments" ADD COLUMN "file_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[], ADD COLUMN "mention_user_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
