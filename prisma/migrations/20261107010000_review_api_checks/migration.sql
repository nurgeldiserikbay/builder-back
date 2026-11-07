CREATE TABLE "review_api_checks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "review_run_id" UUID NOT NULL,
  "page_id" UUID NOT NULL,
  "author_user_id" UUID NOT NULL,
  "method" VARCHAR(4) NOT NULL,
  "endpoint" VARCHAR(2048) NOT NULL,
  "expected_status" INTEGER NOT NULL,
  "actual_status" INTEGER,
  "duration_ms" INTEGER NOT NULL,
  "passed" BOOLEAN NOT NULL,
  "json_path" VARCHAR(160),
  "json_matches" BOOLEAN,
  "safe_error_code" VARCHAR(32),
  "checked_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "review_api_checks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_api_checks_review_run_id_fkey" FOREIGN KEY ("review_run_id") REFERENCES "review_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "review_api_checks_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "review_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "review_api_checks_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "review_api_checks_method_check" CHECK ("method" IN ('GET', 'HEAD')),
  CONSTRAINT "review_api_checks_expected_status_check" CHECK ("expected_status" BETWEEN 100 AND 599),
  CONSTRAINT "review_api_checks_actual_status_check" CHECK ("actual_status" IS NULL OR "actual_status" BETWEEN 100 AND 599),
  CONSTRAINT "review_api_checks_duration_check" CHECK ("duration_ms" BETWEEN 0 AND 12000),
  CONSTRAINT "review_api_checks_safe_error_code_check" CHECK ("safe_error_code" IS NULL OR "safe_error_code" IN ('REQUEST_FAILED', 'REQUEST_TIMEOUT'))
);
CREATE INDEX "review_api_checks_run_page_created_idx" ON "review_api_checks"("review_run_id", "page_id", "created_at" DESC);
CREATE INDEX "review_api_checks_author_created_idx" ON "review_api_checks"("author_user_id", "created_at" DESC);
