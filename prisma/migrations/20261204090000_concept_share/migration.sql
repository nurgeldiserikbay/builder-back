-- «Показать другому человеку»: a read-only link to the product concept, and remarks left by its readers.
CREATE TABLE "concept_shares" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "token" VARCHAR(48) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allow_comments" BOOLEAN NOT NULL DEFAULT true,
    "hidden_sections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "views" INTEGER NOT NULL DEFAULT 0,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "concept_shares_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "concept_shares_project_id_key" ON "concept_shares"("project_id");
CREATE UNIQUE INDEX "concept_shares_token_key" ON "concept_shares"("token");
ALTER TABLE "concept_shares" ADD CONSTRAINT "concept_shares_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "guest_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "share_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "section" VARCHAR(40),
    "text" VARCHAR(1000) NOT NULL,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "guest_comments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "guest_comments_share_id_created_at_idx" ON "guest_comments"("share_id", "created_at");
ALTER TABLE "guest_comments" ADD CONSTRAINT "guest_comments_share_id_fkey" FOREIGN KEY ("share_id") REFERENCES "concept_shares"("id") ON DELETE CASCADE ON UPDATE CASCADE;
