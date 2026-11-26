-- Module branches: each module's code has its own line, merged into the project's main line when the module is accepted.
ALTER TABLE "agent_tasks" ADD COLUMN "line_task_id" UUID;
CREATE INDEX "agent_tasks_project_kind_idx" ON "agent_tasks"("project_id", "kind", "created_at");
