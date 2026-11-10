-- Change notices: response deadline with one reminder and escalation to the owner; on-demand AI explanation.
ALTER TABLE "projects" ADD COLUMN "change_response_days" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "projects" ADD CONSTRAINT "projects_change_response_days_check" CHECK ("change_response_days" BETWEEN 1 AND 14);
ALTER TABLE "change_notices" ADD COLUMN "respond_by" TIMESTAMPTZ(3);
ALTER TABLE "change_notices" ADD COLUMN "reminded_at" TIMESTAMPTZ(3);
ALTER TABLE "change_notices" ADD COLUMN "escalated_at" TIMESTAMPTZ(3);
ALTER TABLE "change_notices" ADD COLUMN "ai_explanation" JSONB;
ALTER TABLE "change_notices" ADD COLUMN "ai_explained_at" TIMESTAMPTZ(3);
-- Notices already open get the default deadline from now.
UPDATE "change_notices" SET "respond_by" = CURRENT_TIMESTAMP + INTERVAL '3 days' WHERE "status" = 'open';
CREATE INDEX "change_notices_status_respond_idx" ON "change_notices"("status", "respond_by");
