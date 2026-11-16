-- Change proposals (STAGE_WORK_MODEL §6, §10): a specialist asks to change an accepted requirement; the owner decides.
CREATE TYPE "ChangeProposalStatus" AS ENUM ('open', 'accepted', 'rejected', 'withdrawn');

CREATE TABLE "change_proposals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "from_stage_id" UUID NOT NULL,
  "target_stage_id" UUID NOT NULL,
  "author_user_id" UUID NOT NULL,
  "text" VARCHAR(1000) NOT NULL,
  "status" "ChangeProposalStatus" NOT NULL DEFAULT 'open',
  "decided_by_user_id" UUID,
  "decision_note" VARCHAR(500),
  "decided_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "change_proposals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "change_proposals_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
  CONSTRAINT "change_proposals_from_stage_fkey" FOREIGN KEY ("from_stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE,
  CONSTRAINT "change_proposals_target_stage_fkey" FOREIGN KEY ("target_stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE,
  CONSTRAINT "change_proposals_author_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "change_proposals_decider_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE INDEX "change_proposals_project_status_idx" ON "change_proposals" ("project_id", "status", "created_at" DESC);
