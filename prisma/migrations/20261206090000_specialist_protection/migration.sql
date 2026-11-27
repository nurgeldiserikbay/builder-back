-- Watermarks on what a specialist downloads, and confidentiality terms they accept before entering the stage.
ALTER TABLE "stage_assignments" ADD COLUMN "watermark" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stage_assignments" ADD COLUMN "confidentiality_text" VARCHAR(4000);
ALTER TABLE "stage_assignments" ADD COLUMN "confidentiality_accepted_hash" VARCHAR(64);
ALTER TABLE "stage_assignments" ADD COLUMN "confidentiality_accepted_at" TIMESTAMPTZ(3);
