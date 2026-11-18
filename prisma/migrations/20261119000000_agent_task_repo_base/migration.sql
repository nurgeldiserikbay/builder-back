-- A change task may start from the code on the repository's main branch: the files read at queueing time are kept with the
-- task (the digest in base_files_digest), with the commit they came from.
ALTER TABLE "agent_tasks" ADD COLUMN "base_source" VARCHAR(20);
ALTER TABLE "agent_tasks" ADD COLUMN "base_files" JSONB;
ALTER TABLE "agent_tasks" ADD COLUMN "base_commit" VARCHAR(64);
UPDATE "agent_tasks" SET "base_source" = 'task' WHERE "base_task_id" IS NOT NULL;
