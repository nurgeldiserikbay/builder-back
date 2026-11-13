-- Contributors on chosen stages, and remarks on stage materials.
ALTER TABLE "project_members" ADD COLUMN "stage_keys" VARCHAR(40)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(40)[];
ALTER TABLE "project_invitations" ADD COLUMN "stage_keys" VARCHAR(40)[] NOT NULL DEFAULT ARRAY[]::VARCHAR(40)[];

CREATE TABLE "stage_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "parent_id" UUID,
    "version_number" INTEGER,
    "target_key" VARCHAR(60),
    "author_user_id" UUID NOT NULL,
    "text" VARCHAR(2000) NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stage_comments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "stage_comments_stage_created_idx" ON "stage_comments"("stage_id", "created_at");
ALTER TABLE "stage_comments" ADD CONSTRAINT "stage_comments_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
