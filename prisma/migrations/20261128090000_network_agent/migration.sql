-- «Агент в вашей сети» (PRODUCT_LIFECYCLE §7, step 11): agents run by owners inside their networks and their jobs.
CREATE TABLE "network_agents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "token_hint" VARCHAR(8) NOT NULL,
    "capabilities" JSONB,
    "app_url" VARCHAR(300),
    "version" VARCHAR(20),
    "last_seen_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "network_agents_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "network_agents_token_hash_key" ON "network_agents"("token_hash");
CREATE INDEX "network_agents_project_idx" ON "network_agents"("project_id", "revoked_at");
ALTER TABLE "network_agents" ADD CONSTRAINT "network_agents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "network_agent_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "agent_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'queued',
    "result" JSONB,
    "error" VARCHAR(60),
    "requested_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    CONSTRAINT "network_agent_jobs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "network_agent_jobs_agent_status_idx" ON "network_agent_jobs"("agent_id", "status", "created_at");
CREATE INDEX "network_agent_jobs_project_idx" ON "network_agent_jobs"("project_id", "created_at");
ALTER TABLE "network_agent_jobs" ADD CONSTRAINT "network_agent_jobs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "network_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "app_deployments" ADD COLUMN "checked_via" VARCHAR(20) NOT NULL DEFAULT 'platform';
