-- «ИИ-агент»: tasks the agent does in a throwaway sandbox, with live steps, checks and the files it left.
CREATE TABLE "agent_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "instruction" TEXT,
    "profile" VARCHAR(40) NOT NULL,
    "model" VARCHAR(80),
    "locale" VARCHAR(5) NOT NULL,
    "source_version_id" UUID NOT NULL,
    "input_version_ids" UUID[],
    "prompt" JSONB NOT NULL,
    "prompt_digest" VARCHAR(64) NOT NULL,
    "limits" JSONB NOT NULL,
    "stop_requested" BOOLEAN NOT NULL DEFAULT false,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "result" JSONB,
    "files" JSONB,
    "files_digest" VARCHAR(64),
    "turns" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_tiyn" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(60),
    "requested_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agent_tasks_status_created_at_idx" ON "agent_tasks"("status", "created_at");
CREATE INDEX "agent_tasks_project_id_created_at_idx" ON "agent_tasks"("project_id", "created_at");
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
