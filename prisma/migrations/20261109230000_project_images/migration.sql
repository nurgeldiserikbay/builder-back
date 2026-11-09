-- Site photos: re-encoded WebP (max 1600 px, metadata stripped) stored with the project.
CREATE TABLE "project_images" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "data" BYTEA NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "alt" VARCHAR(200) NOT NULL DEFAULT '',
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_images_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_images_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 2000000)
);
CREATE INDEX "project_images_project_created_idx" ON "project_images"("project_id", "created_at" DESC);
ALTER TABLE "project_images" ADD CONSTRAINT "project_images_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
