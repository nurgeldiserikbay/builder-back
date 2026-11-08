ALTER TABLE "admin_audit_events" ADD COLUMN "details" JSONB;

CREATE TYPE "QualityProfileVersionStatus" AS ENUM ('draft', 'active', 'retired');

CREATE TABLE "quality_profiles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" VARCHAR(80) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500) NOT NULL,
  "created_by_staff_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "quality_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "quality_profiles_key_key" ON "quality_profiles"("key");
CREATE INDEX "quality_profiles_created_idx" ON "quality_profiles"("created_at" DESC);
ALTER TABLE "quality_profiles" ADD CONSTRAINT "quality_profiles_created_by_staff_id_fkey" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "quality_profile_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "profile_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "QualityProfileVersionStatus" NOT NULL DEFAULT 'draft',
  "policy" JSONB NOT NULL,
  "authored_by_staff_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activated_at" TIMESTAMPTZ(3),
  CONSTRAINT "quality_profile_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "quality_profile_versions_profile_version_key" ON "quality_profile_versions"("profile_id", "version");
CREATE INDEX "quality_profile_versions_profile_status_idx" ON "quality_profile_versions"("profile_id", "status");
CREATE INDEX "quality_profile_versions_author_created_idx" ON "quality_profile_versions"("authored_by_staff_id", "created_at" DESC);
CREATE UNIQUE INDEX "quality_profile_versions_single_draft_idx" ON "quality_profile_versions"("profile_id") WHERE "status" = 'draft';
CREATE UNIQUE INDEX "quality_profile_versions_single_active_idx" ON "quality_profile_versions"("profile_id") WHERE "status" = 'active';
ALTER TABLE "quality_profile_versions" ADD CONSTRAINT "quality_profile_versions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "quality_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "quality_profile_versions" ADD CONSTRAINT "quality_profile_versions_authored_by_staff_id_fkey" FOREIGN KEY ("authored_by_staff_id") REFERENCES "staff_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
