-- Availability checks of published sites, outage history and the weekly e-mail report.
ALTER TABLE "site_publications" ADD COLUMN "monitor_status" VARCHAR(10) NOT NULL DEFAULT 'unknown';
ALTER TABLE "site_publications" ADD COLUMN "monitor_failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "site_publications" ADD COLUMN "monitor_checked_at" TIMESTAMPTZ(3);
ALTER TABLE "site_publications" ADD COLUMN "monitor_down_since" TIMESTAMPTZ(3);
ALTER TABLE "site_publications" ADD COLUMN "monitor_alerted_at" TIMESTAMPTZ(3);
ALTER TABLE "site_publications" ADD COLUMN "monitor_last_ms" INTEGER;
ALTER TABLE "site_publications" ADD COLUMN "monitor_last_error" VARCHAR(40);
ALTER TABLE "site_publications" ADD COLUMN "weekly_report" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "site_publications" ADD COLUMN "weekly_report_week" VARCHAR(10);
ALTER TABLE "site_publications" ADD CONSTRAINT "site_publications_monitor_status_check" CHECK ("monitor_status" IN ('unknown', 'up', 'down'));

CREATE TABLE "site_incidents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "publication_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "cause" VARCHAR(40) NOT NULL,
    CONSTRAINT "site_incidents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "site_incidents_project_started_idx" ON "site_incidents"("project_id", "started_at" DESC);
ALTER TABLE "site_incidents" ADD CONSTRAINT "site_incidents_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "site_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
