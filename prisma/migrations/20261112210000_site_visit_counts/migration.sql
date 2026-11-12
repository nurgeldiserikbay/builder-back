-- Page views of published sites: day, page and referring host only. No cookies, IP addresses or device data.
CREATE TABLE "site_visit_counts" (
    "project_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "path" VARCHAR(200) NOT NULL,
    "source" VARCHAR(100) NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "site_visit_counts_pkey" PRIMARY KEY ("project_id", "day", "path", "source"),
    CONSTRAINT "site_visit_counts_views_positive" CHECK ("views" >= 0)
);
CREATE INDEX "site_visit_counts_project_day_idx" ON "site_visit_counts"("project_id", "day");
ALTER TABLE "site_visit_counts" ADD CONSTRAINT "site_visit_counts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
