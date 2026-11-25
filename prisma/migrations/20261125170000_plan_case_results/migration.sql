-- The latest result of each test case of an accepted test plan («План проверки»), by case key.
CREATE TYPE "PlanCaseStatus" AS ENUM ('passed', 'failed');
CREATE TABLE "plan_case_results" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "case_key" VARCHAR(32) NOT NULL,
  "status" "PlanCaseStatus" NOT NULL,
  "note" VARCHAR(500),
  "plan_version" INTEGER NOT NULL,
  "by_user_id" UUID,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "plan_case_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_case_results_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "plan_case_results_project_case_key" ON "plan_case_results" ("project_id", "case_key");
