-- Balance, daily AI limit and monthly plan usage read a project's requests by time.
CREATE INDEX "generation_runs_project_time_idx" ON "generation_runs"("project_id", "created_at" DESC);
-- The platform-wide typical request size reads recent successful requests.
CREATE INDEX "generation_runs_status_created_idx" ON "generation_runs"("status", "created_at" DESC);
