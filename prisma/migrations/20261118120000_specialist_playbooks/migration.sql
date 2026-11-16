-- Personal playbooks of specialists (STAGE_WORK_MODEL §7.4) and the playbook attached to a stage.
CREATE TABLE "specialist_playbooks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "owner_user_id" UUID NOT NULL,
  "stage_key" VARCHAR(40) NOT NULL,
  "title" VARCHAR(80) NOT NULL,
  "instructions" VARCHAR(300)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(300)[],
  "checklist" VARCHAR(300)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(300)[],
  "version" INTEGER NOT NULL DEFAULT 1,
  "check_issues" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "specialist_playbooks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "specialist_playbooks_owner_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "specialist_playbooks_owner_idx" ON "specialist_playbooks" ("owner_user_id", "stage_key");

-- A copy of the playbook as it was attached: later edits by the specialist do not change a stage silently.
CREATE TABLE "stage_playbooks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "stage_id" UUID NOT NULL,
  "playbook_id" UUID,
  "attached_by_user_id" UUID NOT NULL,
  "title" VARCHAR(80) NOT NULL,
  "version" INTEGER NOT NULL,
  "instructions" VARCHAR(300)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(300)[],
  "checklist" VARCHAR(300)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(300)[],
  "attached_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "stage_playbooks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "stage_playbooks_stage_key" UNIQUE ("stage_id"),
  CONSTRAINT "stage_playbooks_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
  CONSTRAINT "stage_playbooks_stage_fkey" FOREIGN KEY ("stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE,
  CONSTRAINT "stage_playbooks_playbook_fkey" FOREIGN KEY ("playbook_id") REFERENCES "specialist_playbooks"("id") ON DELETE SET NULL,
  CONSTRAINT "stage_playbooks_attacher_fkey" FOREIGN KEY ("attached_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

-- Which specialist playbook (id@version) a generation used, for provenance.
ALTER TABLE "generation_runs" ADD COLUMN "specialist_playbook" VARCHAR(60);
