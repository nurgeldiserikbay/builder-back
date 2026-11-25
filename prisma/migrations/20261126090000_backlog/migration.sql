-- «Развитие»: the backlog of what comes next, gathered from the accepted stages and people's feedback.
CREATE TABLE "backlog_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "details" VARCHAR(1000),
  "source" VARCHAR(20) NOT NULL,
  "source_key" VARCHAR(64),
  "priority" VARCHAR(10) NOT NULL DEFAULT 'medium',
  "status" VARCHAR(10) NOT NULL DEFAULT 'open',
  "version" INTEGER,
  "created_by_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "backlog_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "backlog_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "backlog_items_project_source_key" ON "backlog_items" ("project_id", "source", "source_key");
CREATE INDEX "backlog_items_project_status_idx" ON "backlog_items" ("project_id", "status");
