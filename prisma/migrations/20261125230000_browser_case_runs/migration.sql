-- The AI agent checks the test plan's browser cases in the preview of an agent task.
CREATE TABLE "browser_case_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "agent_task_id" UUID NOT NULL,
  "plan_version" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
  "case_keys" VARCHAR(32)[],
  "results" JSONB NOT NULL DEFAULT '[]',
  "model" VARCHAR(80),
  "turns" INTEGER NOT NULL DEFAULT 0,
  "cost_tiyn" INTEGER NOT NULL DEFAULT 0,
  "error_code" VARCHAR(60),
  "requested_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(3),
  "finished_at" TIMESTAMPTZ(3),
  CONSTRAINT "browser_case_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "browser_case_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "browser_case_runs_project_idx" ON "browser_case_runs" ("project_id", "created_at" DESC);
CREATE INDEX "browser_case_runs_status_idx" ON "browser_case_runs" ("status", "created_at");
