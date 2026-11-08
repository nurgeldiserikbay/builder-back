ALTER TABLE "quality_profiles" ADD COLUMN "is_default" BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX "quality_profiles_single_default_idx" ON "quality_profiles" ("is_default") WHERE "is_default" = TRUE;
