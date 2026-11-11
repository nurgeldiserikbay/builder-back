-- Masters of a booking schedule see only their own bookings.
CREATE TABLE "master_accesses" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "master_key" VARCHAR(12) NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "user_id" UUID,
  "status" VARCHAR(10) NOT NULL DEFAULT 'invited',
  "invite_token_hash" VARCHAR(64) NOT NULL,
  "invite_expires_at" TIMESTAMPTZ(3) NOT NULL,
  "invited_by_user_id" UUID NOT NULL,
  "accepted_at" TIMESTAMPTZ(3),
  "revoked_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "master_accesses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "master_accesses_status_check" CHECK ("status" IN ('invited', 'active', 'revoked')),
  CONSTRAINT "master_accesses_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "master_accesses_invite_token_hash_key" ON "master_accesses" ("invite_token_hash");
CREATE INDEX "master_accesses_project_master_idx" ON "master_accesses" ("project_id", "master_key");
CREATE INDEX "master_accesses_user_idx" ON "master_accesses" ("user_id");
-- At most one open access per master.
CREATE UNIQUE INDEX "master_accesses_one_open_per_master" ON "master_accesses" ("project_id", "master_key") WHERE "status" <> 'revoked';
