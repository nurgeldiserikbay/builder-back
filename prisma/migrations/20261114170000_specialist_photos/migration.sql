-- Photos for specialists' portfolio works.
CREATE TABLE "specialist_photos" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "data" BYTEA NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "specialist_photos_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "specialist_photos_user_created_idx" ON "specialist_photos"("user_id", "created_at");
ALTER TABLE "specialist_photos" ADD CONSTRAINT "specialist_photos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
