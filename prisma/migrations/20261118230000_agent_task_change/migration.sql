-- Step 5: a change task starts from the files of an earlier task (its base), checked by their digest.
ALTER TABLE "agent_tasks" ADD COLUMN "base_task_id" UUID;
ALTER TABLE "agent_tasks" ADD COLUMN "base_files_digest" VARCHAR(64);
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_base_task_id_fkey" FOREIGN KEY ("base_task_id") REFERENCES "agent_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
