-- Feedback from launched applications: a public, write-only token per project; messages become backlog items.
CREATE TABLE "feedback_inboxes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "token" VARCHAR(48) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "received" INTEGER NOT NULL DEFAULT 0,
    "last_received_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "feedback_inboxes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "feedback_inboxes_project_id_key" ON "feedback_inboxes"("project_id");
CREATE UNIQUE INDEX "feedback_inboxes_token_key" ON "feedback_inboxes"("token");
ALTER TABLE "feedback_inboxes" ADD CONSTRAINT "feedback_inboxes_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
