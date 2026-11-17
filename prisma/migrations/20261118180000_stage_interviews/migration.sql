-- «Разговор» on a form stage: the conversation that fills the form, one per stage.
CREATE TABLE "stage_interviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "mode" VARCHAR(10) NOT NULL,
    "messages" JSONB NOT NULL,
    "extracted" JSONB NOT NULL,
    "pending_field" VARCHAR(40),
    "asked" VARCHAR(40)[] DEFAULT ARRAY[]::VARCHAR(40)[],
    "done" BOOLEAN NOT NULL DEFAULT false,
    "applied_version_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "stage_interviews_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "stage_interviews_stage_id_key" ON "stage_interviews"("stage_id");
CREATE INDEX "stage_interviews_project_id_idx" ON "stage_interviews"("project_id");
ALTER TABLE "stage_interviews" ADD CONSTRAINT "stage_interviews_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
