-- Project team: invitations to the whole project and approval policies with several reviewers.
ALTER TABLE "project_stages" ADD COLUMN "approval_policy" JSONB, ADD COLUMN "approval_round" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "project_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "role" "ProjectRole" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "accepted_user_id" UUID,
    "revoked_at" TIMESTAMPTZ(3),
    "invited_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_invitations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "project_invitations_token_hash_key" ON "project_invitations"("token_hash");
CREATE INDEX "project_invitations_project_created_idx" ON "project_invitations"("project_id", "created_at" DESC);
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "stage_approvals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "user_id" UUID NOT NULL,
    "comment" VARCHAR(1000),
    "policy" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stage_approvals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "stage_approvals_once_key" ON "stage_approvals"("stage_id", "version_id", "round", "user_id");
CREATE INDEX "stage_approvals_project_created_idx" ON "stage_approvals"("project_id", "created_at" DESC);
ALTER TABLE "stage_approvals" ADD CONSTRAINT "stage_approvals_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
