-- Account deletion with a retention period, recorded consent to the legal documents.
ALTER TABLE "users" ADD COLUMN "deletion_requested_at" TIMESTAMPTZ(3);
CREATE INDEX "users_deletion_requested_idx" ON "users"("deletion_requested_at");

CREATE TABLE "user_consents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "terms_version" VARCHAR(20) NOT NULL,
    "privacy_version" VARCHAR(20) NOT NULL,
    "source" VARCHAR(20) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "user_consents_user_accepted_idx" ON "user_consents"("user_id", "accepted_at" DESC);
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "privacy_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "account_retention_days" INTEGER NOT NULL DEFAULT 30,
    "updated_by_staff_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "privacy_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "privacy_settings_single_row" CHECK ("id" = 1),
    CONSTRAINT "privacy_settings_retention_range" CHECK ("account_retention_days" BETWEEN 1 AND 90)
);
