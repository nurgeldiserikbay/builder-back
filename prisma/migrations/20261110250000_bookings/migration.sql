-- Online booking route: client bookings on published sites.
CREATE TABLE "bookings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "publication_id" UUID NOT NULL,
  "service_name" VARCHAR(80) NOT NULL,
  "minutes" INTEGER NOT NULL,
  "price" VARCHAR(40),
  "master_key" VARCHAR(12) NOT NULL,
  "master_name" VARCHAR(60) NOT NULL,
  "starts_at" TIMESTAMPTZ(3) NOT NULL,
  "ends_at" TIMESTAMPTZ(3) NOT NULL,
  "timezone" VARCHAR(40) NOT NULL,
  "client_name" VARCHAR(80) NOT NULL,
  "client_phone" VARCHAR(30) NOT NULL,
  "comment" VARCHAR(300),
  "status" VARCHAR(20) NOT NULL DEFAULT 'booked',
  "token_hash" VARCHAR(64) NOT NULL,
  "consent_at" TIMESTAMPTZ(3) NOT NULL,
  "ip_hash" VARCHAR(64) NOT NULL,
  "telegram_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "cancelled_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bookings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "bookings_time_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "bookings_status_check" CHECK ("status" IN ('booked', 'cancelled_by_client', 'cancelled_by_owner', 'done', 'no_show'))
);
CREATE UNIQUE INDEX "bookings_token_hash_key" ON "bookings"("token_hash");
CREATE INDEX "bookings_publication_master_start_idx" ON "bookings"("publication_id", "master_key", "starts_at");
CREATE INDEX "bookings_project_start_idx" ON "bookings"("project_id", "starts_at");
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "site_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
