-- Connect GitHub with one tap (OAuth): per-person accounts, single-use states, how a repository was connected.
CREATE TABLE "git_accounts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "provider" VARCHAR(20) NOT NULL,
  "login" VARCHAR(100) NOT NULL,
  "token_encrypted" TEXT NOT NULL,
  "token_hint" VARCHAR(8) NOT NULL,
  "scopes" VARCHAR(200) NOT NULL DEFAULT '',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "git_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "git_accounts_user_provider_key" ON "git_accounts"("user_id", "provider");
ALTER TABLE "git_accounts" ADD CONSTRAINT "git_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "oauth_states" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "state_hash" VARCHAR(64) NOT NULL,
  "user_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "provider" VARCHAR(20) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "oauth_states_state_hash_key" ON "oauth_states"("state_hash");
CREATE INDEX "oauth_states_expires_idx" ON "oauth_states"("expires_at");
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "code_repositories" ADD COLUMN "connected_via" VARCHAR(10) NOT NULL DEFAULT 'token';
