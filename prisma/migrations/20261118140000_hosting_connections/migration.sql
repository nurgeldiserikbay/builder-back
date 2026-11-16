-- A project's connection to an external static hosting (deployment card): the site there and an encrypted access token.
CREATE TABLE "hosting_connections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "provider" VARCHAR(20) NOT NULL,
  "account" VARCHAR(120) NOT NULL,
  "site_id" VARCHAR(80) NOT NULL,
  "site_url" VARCHAR(300) NOT NULL,
  "admin_url" VARCHAR(300),
  "token_encrypted" TEXT NOT NULL,
  "token_hint" VARCHAR(8) NOT NULL,
  "connected_by_user_id" UUID NOT NULL,
  "last_deploy_at" TIMESTAMPTZ(3),
  "last_deploy_id" VARCHAR(80),
  "last_build_version_id" UUID,
  "last_error" VARCHAR(80),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hosting_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hosting_connections_project_key" UNIQUE ("project_id"),
  CONSTRAINT "hosting_connections_project_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE
);
