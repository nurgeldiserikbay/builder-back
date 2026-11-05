CREATE TYPE "ReviewMode" AS ENUM ('site_only', 'site_and_design', 'design_only');
CREATE TYPE "ReviewStatus" AS ENUM ('draft', 'queued', 'discovering', 'ready', 'failed', 'cancelled');
CREATE TYPE "ReviewLocale" AS ENUM ('en', 'ru', 'kk');
CREATE TYPE "ReviewPageStatus" AS ENUM ('discovered', 'mapped', 'capture_queued', 'captured', 'failed', 'excluded');
CREATE TYPE "DesignSourceType" AS ENUM ('upload', 'figma');
CREATE TYPE "DesignAssetStatus" AS ENUM ('pending', 'scanning', 'verified', 'rejected', 'failed');
CREATE TYPE "ReviewCaptureStatus" AS ENUM ('queued', 'captured', 'failed');
CREATE TYPE "ReviewFindingCategory" AS ENUM ('requirement', 'design', 'backend', 'accessibility', 'performance', 'seo', 'security');
CREATE TYPE "ReviewFindingSeverity" AS ENUM ('critical', 'high', 'medium', 'low', 'info');
CREATE TYPE "ReviewFindingStatus" AS ENUM ('open', 'accepted', 'dismissed', 'fixed', 'unknown');
CREATE TYPE "ReviewConfidence" AS ENUM ('high', 'medium', 'low');
CREATE TYPE "ReviewJobType" AS ENUM ('discover_pages', 'capture_page', 'compare_page', 'generate_report', 'export_report');
CREATE TYPE "ReviewJobStatus" AS ENUM ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled');
CREATE TYPE "ReviewReportStatus" AS ENUM ('generating', 'ready', 'failed');

CREATE TABLE "review_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "owner_user_id" UUID NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "mode" "ReviewMode" NOT NULL,
  "status" "ReviewStatus" NOT NULL DEFAULT 'draft',
  "locale" "ReviewLocale" NOT NULL,
  "base_origin" VARCHAR(512),
  "source_snapshot_id" UUID,
  "source_snapshot" JSONB,
  "configuration" JSONB,
  "started_at" TIMESTAMPTZ(3),
  "finished_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "review_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "review_runs_project_created_idx" ON "review_runs"("project_id", "created_at" DESC);
CREATE INDEX "review_runs_owner_created_idx" ON "review_runs"("owner_user_id", "created_at" DESC);
CREATE INDEX "review_runs_status_created_idx" ON "review_runs"("status", "created_at");

CREATE TABLE "review_pages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "review_run_id" UUID NOT NULL,
  "route" VARCHAR(2048) NOT NULL,
  "title" VARCHAR(200),
  "discovery_depth" INTEGER NOT NULL DEFAULT 0,
  "status" "ReviewPageStatus" NOT NULL DEFAULT 'discovered',
  "discovered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "review_pages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_pages_depth_check" CHECK ("discovery_depth" BETWEEN 0 AND 5),
  CONSTRAINT "review_pages_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "review_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "review_pages_run_route_key" ON "review_pages"("review_run_id", "route");
CREATE INDEX "review_pages_run_status_idx" ON "review_pages"("review_run_id", "status");

CREATE TABLE "design_sources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "review_run_id" UUID NOT NULL,
  "source_type" "DesignSourceType" NOT NULL,
  "file_name" VARCHAR(255),
  "mime_type" VARCHAR(128),
  "size_bytes" BIGINT,
  "sha256" CHAR(64),
  "storage_key" VARCHAR(1024),
  "version" VARCHAR(255),
  "asset_status" "DesignAssetStatus" NOT NULL DEFAULT 'pending',
  "figma_file_key" VARCHAR(128),
  "figma_node_id" VARCHAR(128),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "design_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "design_sources_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "review_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "design_sources_run_type_status_idx" ON "design_sources"("review_run_id", "source_type", "asset_status");

CREATE TABLE "page_design_mappings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "page_id" UUID NOT NULL,
  "design_source_id" UUID,
  "viewport_width" INTEGER NOT NULL,
  "viewport_height" INTEGER NOT NULL,
  "device_scale" DECIMAL(4,2) NOT NULL DEFAULT 1,
  "state_recipe" JSONB,
  "requirement_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "api_operation_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "mapping_author_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "page_design_mappings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "page_design_mappings_viewport_check" CHECK ("viewport_width" BETWEEN 1 AND 8192 AND "viewport_height" BETWEEN 1 AND 8192 AND "device_scale" > 0 AND "device_scale" <= 4),
  CONSTRAINT "page_design_mappings_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "review_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "page_design_mappings_design_source_id_fkey" FOREIGN KEY ("design_source_id") REFERENCES "design_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "page_design_mappings_page_id_key" ON "page_design_mappings"("page_id");
CREATE INDEX "page_design_mappings_source_idx" ON "page_design_mappings"("design_source_id");

CREATE TABLE "review_captures" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "page_id" UUID NOT NULL,
  "design_source_id" UUID,
  "status" "ReviewCaptureStatus" NOT NULL DEFAULT 'queued',
  "viewport_width" INTEGER NOT NULL,
  "viewport_height" INTEGER NOT NULL,
  "device_scale" DECIMAL(4,2) NOT NULL DEFAULT 1,
  "asset_storage_key" VARCHAR(1024),
  "sha256" CHAR(64),
  "browser_profile" VARCHAR(128) NOT NULL,
  "tool_version" VARCHAR(128),
  "safe_error_code" VARCHAR(64),
  "captured_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "review_captures_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_captures_viewport_check" CHECK ("viewport_width" BETWEEN 1 AND 8192 AND "viewport_height" BETWEEN 1 AND 8192 AND "device_scale" > 0 AND "device_scale" <= 4),
  CONSTRAINT "review_captures_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "review_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "review_captures_design_source_id_fkey" FOREIGN KEY ("design_source_id") REFERENCES "design_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "review_captures_page_created_idx" ON "review_captures"("page_id", "created_at" DESC);
CREATE INDEX "review_captures_status_created_idx" ON "review_captures"("status", "created_at");

CREATE TABLE "review_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "review_run_id" UUID NOT NULL,
  "job_type" "ReviewJobType" NOT NULL,
  "status" "ReviewJobStatus" NOT NULL DEFAULT 'queued',
  "idempotency_key" VARCHAR(128) NOT NULL,
  "correlation_id" VARCHAR(128) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "progress_percent" INTEGER NOT NULL DEFAULT 0,
  "safe_error_code" VARCHAR(64),
  "result" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(3),
  "finished_at" TIMESTAMPTZ(3),
  CONSTRAINT "review_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_jobs_attempt_count_check" CHECK ("attempt_count" >= 0),
  CONSTRAINT "review_jobs_progress_check" CHECK ("progress_percent" BETWEEN 0 AND 100),
  CONSTRAINT "review_jobs_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "review_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "review_jobs_run_idempotency_key" ON "review_jobs"("review_run_id", "idempotency_key");
CREATE INDEX "review_jobs_status_created_idx" ON "review_jobs"("status", "created_at");
CREATE INDEX "review_jobs_run_created_idx" ON "review_jobs"("review_run_id", "created_at" DESC);

CREATE TABLE "review_findings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "review_run_id" UUID NOT NULL,
  "page_id" UUID,
  "category" "ReviewFindingCategory" NOT NULL,
  "severity" "ReviewFindingSeverity" NOT NULL,
  "status" "ReviewFindingStatus" NOT NULL DEFAULT 'open',
  "confidence" "ReviewConfidence" NOT NULL,
  "summary" VARCHAR(500) NOT NULL,
  "explanation" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "coordinates" JSONB,
  "author_user_id" UUID NOT NULL,
  "assigned_user_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "review_findings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_findings_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "review_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "review_findings_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "review_pages"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "review_findings_run_status_severity_idx" ON "review_findings"("review_run_id", "status", "severity");
CREATE INDEX "review_findings_page_created_idx" ON "review_findings"("page_id", "created_at");

CREATE TABLE "review_reports" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "review_run_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "ReviewReportStatus" NOT NULL DEFAULT 'generating',
  "summary" JSONB NOT NULL,
  "limitations" JSONB NOT NULL,
  "exporter_version" VARCHAR(128) NOT NULL,
  "generated_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "review_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_reports_version_check" CHECK ("version" > 0),
  CONSTRAINT "review_reports_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "review_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "review_reports_run_version_key" ON "review_reports"("review_run_id", "version");
CREATE INDEX "review_reports_run_created_idx" ON "review_reports"("review_run_id", "created_at" DESC);
