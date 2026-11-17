-- Any git over SSH («Свой путь»): a deploy key per project and the host keys the owner confirmed for the connected server.
CREATE TABLE "ssh_deploy_keys" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "public_key" VARCHAR(200) NOT NULL,
    "fingerprint" VARCHAR(80) NOT NULL,
    "private_key_encrypted" TEXT NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ssh_deploy_keys_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ssh_deploy_keys_project_id_key" ON "ssh_deploy_keys"("project_id");
ALTER TABLE "ssh_deploy_keys" ADD CONSTRAINT "ssh_deploy_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "code_repositories" ADD COLUMN "ssh_known_hosts" TEXT;
