-- Specialist terms (fixed price or hourly), tracked time and payments due on acceptance.
ALTER TABLE "stage_assignments" ADD COLUMN "pay_kind" VARCHAR(10) NOT NULL DEFAULT 'none';
ALTER TABLE "stage_assignments" ADD COLUMN "fixed_amount_tiyn" INTEGER;
ALTER TABLE "stage_assignments" ADD COLUMN "hourly_rate_tiyn" INTEGER;
ALTER TABLE "stage_assignments" ADD COLUMN "hour_limit" INTEGER;
ALTER TABLE "stage_assignments" ADD COLUMN "weekly_hour_limit" INTEGER;
ALTER TABLE "stage_assignments" ADD COLUMN "revisions_included" INTEGER;
ALTER TABLE "stage_assignments" ADD COLUMN "only_result_time" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stage_assignments" ADD COLUMN "limit_warned_at" TIMESTAMPTZ(3);
ALTER TABLE "stage_assignments" ADD CONSTRAINT "stage_assignments_pay_kind_check" CHECK ("pay_kind" IN ('none', 'fixed', 'hourly'));

CREATE TABLE "time_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assignment_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3) NOT NULL,
    "source" VARCHAR(10) NOT NULL,
    "actions" INTEGER NOT NULL DEFAULT 0,
    "note" VARCHAR(500),
    "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
    "owner_comment" VARCHAR(1000),
    "specialist_reply" VARCHAR(1000),
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "time_entries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "time_entries_period_check" CHECK ("ended_at" >= "started_at")
);
CREATE INDEX "time_entries_assignment_started_idx" ON "time_entries"("assignment_id", "started_at" DESC);
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "stage_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "stage_payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assignment_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "basis" VARCHAR(10) NOT NULL,
    "minutes" INTEGER,
    "amount_tiyn" INTEGER NOT NULL,
    "status" VARCHAR(12) NOT NULL DEFAULT 'due',
    "stage_version" INTEGER,
    "paid_at" TIMESTAMPTZ(3),
    "marked_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stage_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stage_payments_project_status_idx" ON "stage_payments"("project_id", "status");
ALTER TABLE "stage_payments" ADD CONSTRAINT "stage_payments_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "stage_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
