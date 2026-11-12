-- Specialists can report a review; staff keep or hide it. Hidden reviews are not shown and do not count in the rating.
ALTER TABLE "specialist_reviews" ADD COLUMN "report_status" VARCHAR(10) NOT NULL DEFAULT 'none';
ALTER TABLE "specialist_reviews" ADD COLUMN "report_reason" VARCHAR(1000);
ALTER TABLE "specialist_reviews" ADD COLUMN "reported_at" TIMESTAMPTZ(3);
ALTER TABLE "specialist_reviews" ADD COLUMN "hidden_at" TIMESTAMPTZ(3);
ALTER TABLE "specialist_reviews" ADD COLUMN "moderation_note" VARCHAR(500);
ALTER TABLE "specialist_reviews" ADD COLUMN "moderated_by_staff_id" UUID;
ALTER TABLE "specialist_reviews" ADD CONSTRAINT "specialist_reviews_report_status_check" CHECK ("report_status" IN ('none', 'pending', 'kept', 'hidden'));
CREATE INDEX "specialist_reviews_report_idx" ON "specialist_reviews"("report_status", "reported_at");
