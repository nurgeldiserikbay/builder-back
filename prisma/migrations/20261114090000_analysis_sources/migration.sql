-- A ZIP can be uploaded straight to code analysis, without a stage (projects started as «Только анализ»).
ALTER TABLE "stage_files" ALTER COLUMN "stage_id" DROP NOT NULL;
