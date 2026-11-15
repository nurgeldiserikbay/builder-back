-- A sign-in with an outside provider (Google) in progress: one row per started attempt, single use, short-lived.
-- The browser that started it holds a random binding value in a cookie; only its hash is stored here.
CREATE TABLE "oauth_login_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" VARCHAR(20) NOT NULL,
    "state_hash" CHAR(64) NOT NULL,
    "binding_hash" CHAR(64) NOT NULL,
    "code_verifier" VARCHAR(128) NOT NULL,
    "nonce" VARCHAR(64) NOT NULL,
    "next_path" VARCHAR(500) NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_login_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_login_states_state_hash_key" ON "oauth_login_states"("state_hash");
CREATE INDEX "oauth_login_states_expires_idx" ON "oauth_login_states"("expires_at");
