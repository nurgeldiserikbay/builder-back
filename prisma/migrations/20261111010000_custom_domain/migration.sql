-- Own domain for a site published on BuildPath.
ALTER TABLE "site_publications" ADD COLUMN "custom_domain" VARCHAR(253);
ALTER TABLE "site_publications" ADD COLUMN "domain_status" VARCHAR(10);
ALTER TABLE "site_publications" ADD COLUMN "domain_checked_at" TIMESTAMPTZ(3);
ALTER TABLE "site_publications" ADD COLUMN "domain_error" VARCHAR(60);
CREATE UNIQUE INDEX "site_publications_custom_domain_key" ON "site_publications"("custom_domain");
ALTER TABLE "site_publications" ADD CONSTRAINT "site_publications_domain_status_check" CHECK ("domain_status" IS NULL OR "domain_status" IN ('pending', 'active', 'failed'));
