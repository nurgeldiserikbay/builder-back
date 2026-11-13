-- Last check of the published address (HTTPS, protective headers).
ALTER TABLE "site_publications" ADD COLUMN "live_check" JSONB, ADD COLUMN "live_checked_at" TIMESTAMPTZ(3);
