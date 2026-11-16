-- Shared rate-limit counters for several API instances (RATE_LIMIT_STORE=database). Keys are hashes, not e-mails or addresses.
CREATE TABLE "rate_limit_hits" (
  "id" BIGSERIAL PRIMARY KEY,
  "key" VARCHAR(80) NOT NULL,
  "at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "rate_limit_hits_key_at_idx" ON "rate_limit_hits" ("key", "at");
CREATE INDEX "rate_limit_hits_expires_idx" ON "rate_limit_hits" ("expires_at");
