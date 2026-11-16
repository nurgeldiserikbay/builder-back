-- Generated code checked in an isolated sandbox (a throwaway virtual machine at the sandbox provider).
CREATE TABLE "sandbox_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "kind" VARCHAR(30) NOT NULL,
  "source_version_id" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
  "files" JSONB NOT NULL,
  "files_digest" VARCHAR(64) NOT NULL,
  "result" JSONB,
  "provider" VARCHAR(30),
  "error_code" VARCHAR(60),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "requested_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(3),
  "finished_at" TIMESTAMPTZ(3),
  CONSTRAINT "sandbox_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sandbox_runs_status_created_idx" ON "sandbox_runs"("status", "created_at");
CREATE INDEX "sandbox_runs_project_kind_created_idx" ON "sandbox_runs"("project_id", "kind", "created_at");
CREATE INDEX "sandbox_runs_source_version_idx" ON "sandbox_runs"("source_version_id");
ALTER TABLE "sandbox_runs" ADD CONSTRAINT "sandbox_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
