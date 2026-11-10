-- AI request history: where the request came from and provider-reported token usage.
ALTER TABLE "generation_runs" ADD COLUMN "source" VARCHAR(20) NOT NULL DEFAULT 'app';
ALTER TABLE "generation_runs" ADD COLUMN "input_tokens" INTEGER;
ALTER TABLE "generation_runs" ADD COLUMN "output_tokens" INTEGER;
CREATE INDEX "generation_runs_project_user_created_idx" ON "generation_runs"("project_id", "requested_by_user_id", "created_at" DESC);
