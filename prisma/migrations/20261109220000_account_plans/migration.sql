-- Plan per account. Limits come from the versioned plan catalog in code (src/billing/plans.ts).
CREATE TABLE "account_plans" (
  "user_id" UUID NOT NULL,
  "plan_key" VARCHAR(40) NOT NULL,
  "valid_until" TIMESTAMPTZ(3),
  "note" VARCHAR(500),
  "assigned_by_staff_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "account_plans_pkey" PRIMARY KEY ("user_id")
);
ALTER TABLE "account_plans" ADD CONSTRAINT "account_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Speeds up monthly AI usage counts per project.
CREATE INDEX "generation_runs_project_created_idx" ON "generation_runs"("project_id", "created_at" DESC) WHERE "provider" <> 'template' AND "status" = 'succeeded';
