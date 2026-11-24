-- Notification settings, two-step sign-in, sessions with device info, sign-in history.
ALTER TABLE "users" ADD COLUMN "notification_prefs" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "users" ADD COLUMN "totp_secret" TEXT;
ALTER TABLE "users" ADD COLUMN "totp_pending_secret" TEXT;
ALTER TABLE "users" ADD COLUMN "totp_enabled_at" TIMESTAMPTZ(3);
ALTER TABLE "users" ADD COLUMN "totp_last_step" INTEGER;
ALTER TABLE "users" ADD COLUMN "recovery_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "user_sessions" ADD COLUMN "method" VARCHAR(12) NOT NULL DEFAULT 'password';
ALTER TABLE "user_sessions" ADD COLUMN "user_agent" VARCHAR(300);
ALTER TABLE "user_sessions" ADD COLUMN "ip_hint" VARCHAR(64);

CREATE TABLE "login_challenges" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "used_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "login_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "login_challenges_token_hash_key" ON "login_challenges" ("token_hash");

CREATE TABLE "login_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "method" VARCHAR(12) NOT NULL,
  "outcome" VARCHAR(16) NOT NULL,
  "user_agent" VARCHAR(300),
  "ip_hint" VARCHAR(64),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "login_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "login_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "login_events_user_created_idx" ON "login_events" ("user_id", "created_at" DESC);
