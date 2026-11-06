CREATE TYPE "ReviewRequirementStatus" AS ENUM ('pending', 'satisfied', 'failed', 'blocked', 'unknown');

CREATE TABLE "review_requirements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "review_run_id" UUID NOT NULL,
    "page_id" UUID,
    "category" "ReviewFindingCategory" NOT NULL DEFAULT 'requirement',
    "title" VARCHAR(500) NOT NULL,
    "details" TEXT,
    "status" "ReviewRequirementStatus" NOT NULL DEFAULT 'pending',
    "verification_note" VARCHAR(2000),
    "evidence_capture_id" UUID,
    "author_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "review_requirements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "review_requirements_run_page_status_idx"
    ON "review_requirements"("review_run_id", "page_id", "status");
CREATE INDEX "review_requirements_capture_idx"
    ON "review_requirements"("evidence_capture_id");

ALTER TABLE "review_requirements"
    ADD CONSTRAINT "review_requirements_review_run_id_fkey"
    FOREIGN KEY ("review_run_id") REFERENCES "review_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_requirements"
    ADD CONSTRAINT "review_requirements_page_id_fkey"
    FOREIGN KEY ("page_id") REFERENCES "review_pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "review_requirements"
    ADD CONSTRAINT "review_requirements_evidence_capture_id_fkey"
    FOREIGN KEY ("evidence_capture_id") REFERENCES "review_captures"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "review_requirements"
    ADD CONSTRAINT "review_requirements_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
