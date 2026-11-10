-- Change notices between stages: pinned inputs, decisions and discussion.
CREATE TYPE "ChangeNoticeStatus" AS ENUM ('open', 'discussing', 'accepted', 'accepted_no_change', 'superseded');

CREATE TABLE "change_notices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "source_stage_id" UUID NOT NULL,
    "target_stage_id" UUID NOT NULL,
    "previous_version_id" UUID NOT NULL,
    "new_version_id" UUID NOT NULL,
    "changes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "ChangeNoticeStatus" NOT NULL DEFAULT 'open',
    "created_by_user_id" UUID NOT NULL,
    "decided_by_user_id" UUID,
    "decided_by_owner" BOOLEAN NOT NULL DEFAULT false,
    "decided_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "change_notices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "change_notices_target_status_idx" ON "change_notices"("target_stage_id", "status");
CREATE INDEX "change_notices_source_status_idx" ON "change_notices"("source_stage_id", "status");
ALTER TABLE "change_notices" ADD CONSTRAINT "change_notices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "change_notices" ADD CONSTRAINT "change_notices_source_stage_id_fkey" FOREIGN KEY ("source_stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "change_notices" ADD CONSTRAINT "change_notices_target_stage_id_fkey" FOREIGN KEY ("target_stage_id") REFERENCES "project_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- At most one undecided notice per pair of stages.
CREATE UNIQUE INDEX "change_notices_one_open_per_pair" ON "change_notices"("source_stage_id", "target_stage_id") WHERE "status" IN ('open', 'discussing');

CREATE TABLE "change_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "notice_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "side" VARCHAR(10) NOT NULL,
    "resolution" VARCHAR(20),
    "text" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "change_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "change_messages_notice_created_idx" ON "change_messages"("notice_id", "created_at");
ALTER TABLE "change_messages" ADD CONSTRAINT "change_messages_notice_id_fkey" FOREIGN KEY ("notice_id") REFERENCES "change_notices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
