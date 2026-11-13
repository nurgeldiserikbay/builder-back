-- Files attached to stages and read-only analysis runs of source archives.
CREATE TABLE "stage_files" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "stage_id" UUID NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "mime" VARCHAR(100) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "note" VARCHAR(500) NOT NULL DEFAULT '',
  "data" BYTEA NOT NULL,
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stage_files_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stage_files_stage_created_idx" ON "stage_files"("stage_id", "created_at" DESC);
CREATE INDEX "stage_files_project_idx" ON "stage_files"("project_id");
ALTER TABLE "stage_files" ADD CONSTRAINT "stage_files_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_files" ADD CONSTRAINT "stage_files_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "analysis_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
  "source_kind" VARCHAR(20) NOT NULL,
  "source_file_id" UUID,
  "source_label" VARCHAR(300) NOT NULL,
  "source_ref" VARCHAR(200),
  "source_sha256" VARCHAR(64),
  "profile" VARCHAR(40) NOT NULL,
  "idempotency_key" VARCHAR(80),
  "report" JSONB,
  "error_code" VARCHAR(60),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "requested_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(3),
  "finished_at" TIMESTAMPTZ(3),
  CONSTRAINT "analysis_runs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "analysis_runs_project_idempotency_key" ON "analysis_runs"("project_id", "idempotency_key");
CREATE INDEX "analysis_runs_project_created_idx" ON "analysis_runs"("project_id", "created_at" DESC);
CREATE INDEX "analysis_runs_status_created_idx" ON "analysis_runs"("status", "created_at");
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
