CREATE TABLE "figma_oauth_states" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "state_hash" CHAR(64) NOT NULL,
  "code_verifier" VARCHAR(128) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "figma_oauth_states_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "figma_oauth_states_state_hash_key" ON "figma_oauth_states"("state_hash");
CREATE INDEX "figma_oauth_states_user_expires_idx" ON "figma_oauth_states"("user_id", "expires_at");
ALTER TABLE "figma_oauth_states" ADD CONSTRAINT "figma_oauth_states_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "figma_connections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "figma_user_id" VARCHAR(128),
  "access_token_encrypted" TEXT NOT NULL,
  "refresh_token_encrypted" TEXT NOT NULL,
  "access_token_expires_at" TIMESTAMPTZ(3) NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "connected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "figma_connections_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "figma_connections_user_id_key" ON "figma_connections"("user_id");
ALTER TABLE "figma_connections" ADD CONSTRAINT "figma_connections_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
