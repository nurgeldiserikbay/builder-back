-- Money held for an AI request while it runs; one active hold per project.
CREATE TABLE "ai_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "amount_tiyn" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_reservations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ai_reservations_project_expires_idx" ON "ai_reservations"("project_id", "expires_at");
ALTER TABLE "ai_reservations" ADD CONSTRAINT "ai_reservations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
