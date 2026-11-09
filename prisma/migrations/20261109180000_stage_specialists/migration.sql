-- Specialists invited to a single stage: they direct the stage AI (lead) or advise (consultant).
-- They are not project members, so every project-wide permission check keeps excluding them.
ALTER TYPE "StageInstructionKind" ADD VALUE IF NOT EXISTS 'suggestion';
ALTER TYPE "StageInstructionStatus" ADD VALUE IF NOT EXISTS 'proposed';
ALTER TYPE "StageInstructionStatus" ADD VALUE IF NOT EXISTS 'applied';
ALTER TYPE "StageInstructionStatus" ADD VALUE IF NOT EXISTS 'dismissed';

CREATE TYPE "StageAssignmentRole" AS ENUM ('lead', 'consultant');
CREATE TYPE "StageAssignmentStatus" AS ENUM ('invited', 'active', 'completed', 'revoked');

ALTER TABLE "project_stages" ADD COLUMN "review_note" VARCHAR(1000);

CREATE TABLE "stage_assignments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "stage_id" UUID NOT NULL,
  "user_id" UUID,
  "email" VARCHAR(254) NOT NULL,
  "role" "StageAssignmentRole" NOT NULL,
  "status" "StageAssignmentStatus" NOT NULL DEFAULT 'invited',
  "invite_token_hash" VARCHAR(64) NOT NULL,
  "invite_expires_at" TIMESTAMPTZ(3) NOT NULL,
  "ai_budget" INTEGER,
  "ai_used" INTEGER NOT NULL DEFAULT 0,
  "invited_by_user_id" UUID NOT NULL,
  "accepted_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "read_until" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "stage_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stage_assignments_ai_budget_check" CHECK ("ai_budget" IS NULL OR "ai_budget" >= 0)
);
CREATE UNIQUE INDEX "stage_assignments_invite_token_hash_key" ON "stage_assignments"("invite_token_hash");
CREATE INDEX "stage_assignments_project_stage_status_idx" ON "stage_assignments"("project_id", "stage_id", "status");
CREATE INDEX "stage_assignments_user_status_idx" ON "stage_assignments"("user_id", "status");
-- At most one lead per stage that is invited or working.
CREATE UNIQUE INDEX "stage_assignments_one_open_lead_idx" ON "stage_assignments"("stage_id") WHERE "role" = 'lead' AND "status" IN ('invited', 'active');
ALTER TABLE "stage_assignments" ADD CONSTRAINT "stage_assignments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_assignments" ADD CONSTRAINT "stage_assignments_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_assignments" ADD CONSTRAINT "stage_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
