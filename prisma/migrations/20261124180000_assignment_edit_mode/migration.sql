-- How a lead specialist may change the stage: by hand and through the AI, only through the AI, or only by hand.
ALTER TABLE "stage_assignments" ADD COLUMN "edit_mode" VARCHAR(12) NOT NULL DEFAULT 'both';
ALTER TABLE "stage_assignments" ADD CONSTRAINT "stage_assignments_edit_mode_check" CHECK ("edit_mode" IN ('both', 'ai_only', 'manual_only'));
