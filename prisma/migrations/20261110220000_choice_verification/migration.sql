-- Result of the last automatic check of a choice (e.g. the deployed site opens and matches the accepted version).
ALTER TABLE "project_choices" ADD COLUMN "verification" JSONB;
