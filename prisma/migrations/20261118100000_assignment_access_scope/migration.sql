-- Fine-grained access of a specialist (STAGE_WORK_MODEL §7.2): more results to read, hidden parts, downloads, read period.
ALTER TABLE "stage_assignments"
  ADD COLUMN "extra_read_stages" VARCHAR(40)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(40)[],
  ADD COLUMN "hidden_parts" VARCHAR(40)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(40)[],
  ADD COLUMN "allow_download" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "read_days" INTEGER NOT NULL DEFAULT 7,
  ADD CONSTRAINT "stage_assignments_read_days_check" CHECK ("read_days" BETWEEN 0 AND 30);
