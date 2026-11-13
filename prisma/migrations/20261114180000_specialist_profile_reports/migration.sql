-- Complaints about catalog cards and works; support can hide a card until it restores it.
ALTER TABLE "specialist_profiles" ADD COLUMN "blocked_at" TIMESTAMPTZ(3), ADD COLUMN "blocked_reason" VARCHAR(500);

CREATE TABLE "specialist_profile_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "reporter_user_id" UUID NOT NULL,
    "target" VARCHAR(10) NOT NULL,
    "work_title" VARCHAR(80),
    "work_url" VARCHAR(300),
    "reason" VARCHAR(20) NOT NULL,
    "text" VARCHAR(1000) NOT NULL,
    "status" VARCHAR(15) NOT NULL DEFAULT 'pending',
    "staff_note" VARCHAR(500),
    "decided_by_staff_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "specialist_profile_reports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "specialist_profile_reports_status_idx" ON "specialist_profile_reports"("status", "created_at");
CREATE INDEX "specialist_profile_reports_reporter_idx" ON "specialist_profile_reports"("reporter_user_id", "status");
-- One open complaint per person and card.
CREATE UNIQUE INDEX "specialist_profile_reports_one_pending_idx" ON "specialist_profile_reports"("profile_id", "reporter_user_id") WHERE "status" = 'pending';
ALTER TABLE "specialist_profile_reports" ADD CONSTRAINT "specialist_profile_reports_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "specialist_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "specialist_profile_reports" ADD CONSTRAINT "specialist_profile_reports_reporter_user_id_fkey" FOREIGN KEY ("reporter_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
