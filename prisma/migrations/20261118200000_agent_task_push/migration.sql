-- The agent's work sent to the owner's repository: branch, pull request, commit and time.
ALTER TABLE "agent_tasks" ADD COLUMN "pushed_branch" VARCHAR(120), ADD COLUMN "pull_request_url" VARCHAR(500), ADD COLUMN "commit_url" VARCHAR(500), ADD COLUMN "pushed_at" TIMESTAMPTZ(3);
