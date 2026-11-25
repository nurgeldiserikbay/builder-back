-- The owner's acceptance of the main scenarios, and plan tasks that come from the owner's remarks.
CREATE TYPE "PlanAcceptanceVerdict" AS ENUM ('works', 'broken', 'remark');
CREATE TABLE "plan_case_acceptances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "case_key" VARCHAR(32) NOT NULL,
  "verdict" "PlanAcceptanceVerdict" NOT NULL,
  "note" VARCHAR(500),
  "plan_version" INTEGER NOT NULL,
  "by_user_id" UUID,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "plan_case_acceptances_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_case_acceptances_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "plan_case_acceptances_project_case_key" ON "plan_case_acceptances" ("project_id", "case_key");
ALTER TABLE "plan_task_states"
  ADD COLUMN "title" VARCHAR(200),
  ADD COLUMN "module_key" VARCHAR(32),
  ADD COLUMN "from_case_key" VARCHAR(32);
