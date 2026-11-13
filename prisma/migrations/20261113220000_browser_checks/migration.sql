-- Builds checked in a real browser (Lighthouse on a local copy).
CREATE TABLE "browser_checks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "version_id" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
  "result" JSONB,
  "error_code" VARCHAR(60),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "runs" INTEGER NOT NULL DEFAULT 1,
  "requested_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(3),
  "finished_at" TIMESTAMPTZ(3),
  CONSTRAINT "browser_checks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "browser_checks_version_id_key" ON "browser_checks"("version_id");
CREATE INDEX "browser_checks_status_created_idx" ON "browser_checks"("status", "created_at");
CREATE INDEX "browser_checks_project_idx" ON "browser_checks"("project_id");
ALTER TABLE "browser_checks" ADD CONSTRAINT "browser_checks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
