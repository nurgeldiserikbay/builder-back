-- After launch (PRODUCT_LIFECYCLE §4.13): a launched application is checked every 10 minutes; its incidents are kept.
ALTER TABLE "app_deployments" ADD COLUMN "monitor_status" VARCHAR(10) NOT NULL DEFAULT 'unknown';
ALTER TABLE "app_deployments" ADD COLUMN "monitor_failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "app_deployments" ADD COLUMN "monitor_down_since" TIMESTAMPTZ(3);
ALTER TABLE "app_deployments" ADD COLUMN "monitor_alerted_at" TIMESTAMPTZ(3);
ALTER TABLE "app_deployments" ADD COLUMN "monitor_checked_at" TIMESTAMPTZ(3);
ALTER TABLE "app_deployments" ADD COLUMN "monitor_last_ms" INTEGER;
ALTER TABLE "app_deployments" ADD COLUMN "monitor_last_error" VARCHAR(40);

CREATE TABLE "app_incidents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "cause" VARCHAR(40) NOT NULL,
    "via" VARCHAR(20) NOT NULL,
    CONSTRAINT "app_incidents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "app_incidents_project_started_idx" ON "app_incidents"("project_id", "started_at" DESC);
ALTER TABLE "app_incidents" ADD CONSTRAINT "app_incidents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
