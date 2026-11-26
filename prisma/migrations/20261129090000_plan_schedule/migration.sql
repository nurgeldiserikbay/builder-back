-- The finish of an application's implementation plan: promised, forecast now, last told (PRODUCT_LIFECYCLE §4.8).
CREATE TABLE "plan_schedules" (
    "project_id" UUID NOT NULL,
    "plan_version" INTEGER NOT NULL,
    "baseline_finish" DATE NOT NULL,
    "forecast_finish" DATE NOT NULL,
    "notified_finish" DATE,
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plan_schedules_pkey" PRIMARY KEY ("project_id")
);
ALTER TABLE "plan_schedules" ADD CONSTRAINT "plan_schedules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
