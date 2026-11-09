-- Publication on a BuildPath subdomain, lead forms, and Telegram account linking for notifications.
ALTER TYPE "ProjectStatus" ADD VALUE IF NOT EXISTS 'live';

CREATE TYPE "SitePublicationStatus" AS ENUM ('live', 'unpublished');

CREATE TABLE "site_publications" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "slug" VARCHAR(40) NOT NULL,
  "status" "SitePublicationStatus" NOT NULL,
  "build_version_id" UUID NOT NULL,
  "published_at" TIMESTAMPTZ(3) NOT NULL,
  "published_by_user_id" UUID NOT NULL,
  "unpublished_at" TIMESTAMPTZ(3),
  "notify_telegram" BOOLEAN NOT NULL DEFAULT true,
  "notify_email" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "site_publications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_publications_slug_format_check" CHECK ("slug" ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$')
);
CREATE UNIQUE INDEX "site_publications_project_id_key" ON "site_publications"("project_id");
CREATE UNIQUE INDEX "site_publications_slug_key" ON "site_publications"("slug");
ALTER TABLE "site_publications" ADD CONSTRAINT "site_publications_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "site_leads" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "publication_id" UUID NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "contact" VARCHAR(120) NOT NULL,
  "message" VARCHAR(1000),
  "consent_at" TIMESTAMPTZ(3) NOT NULL,
  "ip_hash" VARCHAR(64) NOT NULL,
  "telegram_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "email_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "site_leads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "site_leads_project_created_idx" ON "site_leads"("project_id", "created_at" DESC);
CREATE INDEX "site_leads_publication_ip_created_idx" ON "site_leads"("publication_id", "ip_hash", "created_at" DESC);
ALTER TABLE "site_leads" ADD CONSTRAINT "site_leads_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "site_leads" ADD CONSTRAINT "site_leads_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "site_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "external_identities" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "provider" VARCHAR(20) NOT NULL,
  "external_id" VARCHAR(64) NOT NULL,
  "chat_id" VARCHAR(64) NOT NULL,
  "username" VARCHAR(64),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "external_identities_user_provider_key" ON "external_identities"("user_id", "provider");
CREATE UNIQUE INDEX "external_identities_provider_external_key" ON "external_identities"("provider", "external_id");
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "telegram_link_codes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "code_hash" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "used_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "telegram_link_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "telegram_link_codes_code_hash_key" ON "telegram_link_codes"("code_hash");
CREATE INDEX "telegram_link_codes_user_created_idx" ON "telegram_link_codes"("user_id", "created_at" DESC);
ALTER TABLE "telegram_link_codes" ADD CONSTRAINT "telegram_link_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
