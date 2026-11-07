ALTER TABLE "review_api_checks"
  ADD COLUMN "requirement_id" UUID;

ALTER TABLE "review_api_checks"
  ADD CONSTRAINT "review_api_checks_requirement_id_fkey"
  FOREIGN KEY ("requirement_id") REFERENCES "review_requirements"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "review_api_checks_requirement_created_idx"
  ON "review_api_checks"("requirement_id", "created_at" DESC);
