-- Agent tasks that build one module of the implementation plan, and test case results from the platform's test runs.
ALTER TABLE "agent_tasks" ADD COLUMN "module_key" VARCHAR(32);
ALTER TABLE "plan_case_results"
  ADD COLUMN "source" VARCHAR(10) NOT NULL DEFAULT 'person',
  ADD COLUMN "agent_task_id" UUID;
