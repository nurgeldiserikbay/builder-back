-- Offers to hand a project to another member of its team.
CREATE TABLE "ownership_transfers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "from_user_id" UUID NOT NULL,
  "to_user_id" UUID NOT NULL,
  "keep_access" BOOLEAN NOT NULL DEFAULT true,
  "status" VARCHAR(12) NOT NULL DEFAULT 'pending',
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "decided_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ownership_transfers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ownership_transfers_project_status_idx" ON "ownership_transfers"("project_id", "status");
CREATE INDEX "ownership_transfers_to_status_idx" ON "ownership_transfers"("to_user_id", "status");
-- At most one open offer per project.
CREATE UNIQUE INDEX "ownership_transfers_one_pending" ON "ownership_transfers"("project_id") WHERE "status" = 'pending';
ALTER TABLE "ownership_transfers" ADD CONSTRAINT "ownership_transfers_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
