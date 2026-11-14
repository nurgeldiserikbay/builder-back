-- Advice of the AI reviewer on one version of a stage result. Advice only: it never blocks acceptance.
CREATE TABLE "stage_ai_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "generation_run_id" UUID NOT NULL,
    "findings" JSONB NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stage_ai_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stage_ai_reviews_stage_version_idx" ON "stage_ai_reviews"("stage_id", "version_id", "created_at");
ALTER TABLE "stage_ai_reviews" ADD CONSTRAINT "stage_ai_reviews_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
