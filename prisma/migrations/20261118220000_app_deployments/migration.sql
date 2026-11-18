-- Step 4 of the AI agent: the owner's address of the running application and the last health check.
CREATE TABLE "app_deployments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "url" VARCHAR(300) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "status" INTEGER,
    "database" VARCHAR(20),
    "error" VARCHAR(40),
    "checked_at" TIMESTAMPTZ(3) NOT NULL,
    "checked_by_user_id" UUID NOT NULL,
    CONSTRAINT "app_deployments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "app_deployments_project_id_key" ON "app_deployments"("project_id");
ALTER TABLE "app_deployments" ADD CONSTRAINT "app_deployments_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
