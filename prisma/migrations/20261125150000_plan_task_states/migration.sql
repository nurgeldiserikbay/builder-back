-- Progress of the tasks of an accepted implementation plan («План реализации»), by task key.
CREATE TYPE "PlanTaskStatus" AS ENUM ('not_started', 'in_progress', 'review', 'done', 'done_with_note', 'blocked');
CREATE TABLE "plan_task_states" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "task_key" VARCHAR(32) NOT NULL,
  "status" "PlanTaskStatus" NOT NULL DEFAULT 'not_started',
  "assignee_user_id" UUID,
  "due_date" DATE,
  "note" VARCHAR(500),
  "blocked_by" VARCHAR(300),
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "plan_task_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plan_task_states_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "plan_task_states_project_task_key" ON "plan_task_states" ("project_id", "task_key");
