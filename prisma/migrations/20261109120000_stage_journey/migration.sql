-- Stage-based journey: route, stage state, immutable artifact versions, AI instructions and generation provenance.

-- Project creation stores the creator as an active 'owner' membership (ProjectsService.create); the original
-- check forbade that role, so every project creation failed. Ownership stays recorded in projects.owner_user_id too.
ALTER TABLE "project_members" DROP CONSTRAINT IF EXISTS "project_members_owner_role_check";

ALTER TABLE "projects"
  ADD COLUMN "project_type" VARCHAR(40),
  ADD COLUMN "route_version" VARCHAR(20),
  ADD COLUMN "start_stage_key" VARCHAR(40);

CREATE TYPE "ProjectStageStatus" AS ENUM ('locked', 'ready', 'awaiting_lead', 'in_progress', 'in_review', 'changes_requested', 'approved', 'stale', 'imported', 'skipped', 'blocked');
CREATE TYPE "StageVersionOrigin" AS ENUM ('owner_edit', 'ai_generated', 'template', 'imported', 'compiled', 'restored');
CREATE TYPE "StageInstructionKind" AS ENUM ('one_off', 'stage_rule', 'project_rule');
CREATE TYPE "StageInstructionStatus" AS ENUM ('active', 'disabled');
CREATE TYPE "GenerationRunStatus" AS ENUM ('succeeded', 'failed');

CREATE TABLE "project_stages" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "stage_key" VARCHAR(40) NOT NULL,
  "definition_version" VARCHAR(20) NOT NULL,
  "position" INTEGER NOT NULL,
  "status" "ProjectStageStatus" NOT NULL DEFAULT 'locked',
  "current_version_id" UUID,
  "approved_version_id" UUID,
  "locked_keys" VARCHAR(60)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(60)[],
  "approved_at" TIMESTAMPTZ(3),
  "approved_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_stages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "project_stages_project_key_key" ON "project_stages"("project_id", "stage_key");
CREATE INDEX "project_stages_project_position_idx" ON "project_stages"("project_id", "position");
ALTER TABLE "project_stages" ADD CONSTRAINT "project_stages_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "stage_artifact_versions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "stage_id" UUID NOT NULL,
  "version_number" INTEGER NOT NULL,
  "artifact_type" VARCHAR(40) NOT NULL,
  "content" JSONB NOT NULL,
  "origin" "StageVersionOrigin" NOT NULL,
  "note" VARCHAR(300),
  "created_by_user_id" UUID NOT NULL,
  "generation_run_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stage_artifact_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "stage_artifact_versions_stage_number_key" ON "stage_artifact_versions"("stage_id", "version_number");
CREATE INDEX "stage_artifact_versions_project_created_idx" ON "stage_artifact_versions"("project_id", "created_at" DESC);
ALTER TABLE "stage_artifact_versions" ADD CONSTRAINT "stage_artifact_versions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_artifact_versions" ADD CONSTRAINT "stage_artifact_versions_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "stage_instructions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "stage_id" UUID NOT NULL,
  "author_user_id" UUID NOT NULL,
  "kind" "StageInstructionKind" NOT NULL,
  "status" "StageInstructionStatus" NOT NULL DEFAULT 'active',
  "text" VARCHAR(1000) NOT NULL,
  "target_key" VARCHAR(60),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "stage_instructions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stage_instructions_project_kind_status_idx" ON "stage_instructions"("project_id", "kind", "status");
CREATE INDEX "stage_instructions_stage_created_idx" ON "stage_instructions"("stage_id", "created_at" DESC);
ALTER TABLE "stage_instructions" ADD CONSTRAINT "stage_instructions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stage_instructions" ADD CONSTRAINT "stage_instructions_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "generation_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "stage_id" UUID NOT NULL,
  "requested_by_user_id" UUID NOT NULL,
  "provider" VARCHAR(40) NOT NULL,
  "model" VARCHAR(80),
  "playbook_version" VARCHAR(20) NOT NULL,
  "target_key" VARCHAR(60),
  "instruction_id" UUID,
  "rule_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "input_version_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "base_version_id" UUID,
  "result_version_id" UUID,
  "status" "GenerationRunStatus" NOT NULL,
  "safe_error_code" VARCHAR(80),
  "duration_ms" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "generation_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "generation_runs_project_provider_created_idx" ON "generation_runs"("project_id", "provider", "created_at" DESC);
CREATE INDEX "generation_runs_stage_created_idx" ON "generation_runs"("stage_id", "created_at" DESC);
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "project_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "actor_user_id" UUID,
  "type" VARCHAR(60) NOT NULL,
  "stage_key" VARCHAR(40),
  "details" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "project_events_project_created_idx" ON "project_events"("project_id", "created_at" DESC);
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
