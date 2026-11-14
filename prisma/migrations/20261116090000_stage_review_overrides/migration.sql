-- The owner's written explanation for moving a stage on with blocking review findings: per version, never edited.
CREATE TABLE "stage_review_overrides" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "rules_version" VARCHAR(20) NOT NULL,
    "finding_ids" VARCHAR(120)[] NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "author_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stage_review_overrides_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stage_review_overrides_stage_version_idx" ON "stage_review_overrides"("stage_id", "version_id");
ALTER TABLE "stage_review_overrides" ADD CONSTRAINT "stage_review_overrides_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
