CREATE TYPE "StaffRole" AS ENUM ('super_admin', 'quality_admin', 'operations_auditor');
CREATE TYPE "StaffAccountStatus" AS ENUM ('active', 'suspended');

CREATE TABLE "staff_accounts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "email" VARCHAR(254) NOT NULL,
  "email_normalized" VARCHAR(254) NOT NULL,
  "password_hash" VARCHAR(255) NOT NULL,
  "display_name" VARCHAR(120) NOT NULL,
  "role" "StaffRole" NOT NULL DEFAULT 'operations_auditor',
  "status" "StaffAccountStatus" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "staff_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "staff_accounts_email_normalized_key" ON "staff_accounts"("email_normalized");

CREATE TABLE "staff_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "token_hash" VARCHAR(64) NOT NULL,
  "staff_id" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_sessions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "staff_sessions_token_hash_key" ON "staff_sessions"("token_hash");
CREATE INDEX "staff_sessions_staff_expires_idx" ON "staff_sessions"("staff_id", "expires_at");
CREATE INDEX "staff_sessions_expires_idx" ON "staff_sessions"("expires_at");
ALTER TABLE "staff_sessions" ADD CONSTRAINT "staff_sessions_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "staff_login_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "identifier_hash" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staff_login_attempts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "staff_login_attempts_identifier_created_idx" ON "staff_login_attempts"("identifier_hash", "created_at");

CREATE TABLE "admin_audit_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "staff_id" UUID,
  "event_type" VARCHAR(80) NOT NULL,
  "target_type" VARCHAR(80),
  "target_id" VARCHAR(160),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_audit_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admin_audit_events_staff_created_idx" ON "admin_audit_events"("staff_id", "created_at" DESC);
CREATE INDEX "admin_audit_events_type_created_idx" ON "admin_audit_events"("event_type", "created_at" DESC);
ALTER TABLE "admin_audit_events" ADD CONSTRAINT "admin_audit_events_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
