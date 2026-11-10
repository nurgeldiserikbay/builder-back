-- Choice cards and the connected code repository.
CREATE TABLE "project_choices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "card_key" VARCHAR(40) NOT NULL,
    "card_version" VARCHAR(20) NOT NULL,
    "option_key" VARCHAR(40) NOT NULL,
    "reason" VARCHAR(500),
    "steps_done" VARCHAR(40)[] DEFAULT ARRAY[]::VARCHAR(40)[],
    "chosen_by_user_id" UUID NOT NULL,
    "chosen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "project_choices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "project_choices_project_card_key" ON "project_choices"("project_id", "card_key");
ALTER TABLE "project_choices" ADD CONSTRAINT "project_choices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "code_repositories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "provider" VARCHAR(20) NOT NULL,
    "base_url" VARCHAR(300) NOT NULL,
    "repo_path" VARCHAR(200) NOT NULL,
    "web_url" VARCHAR(500) NOT NULL,
    "default_branch" VARCHAR(120) NOT NULL,
    "is_private" BOOLEAN NOT NULL,
    "token_encrypted" TEXT NOT NULL,
    "token_hint" VARCHAR(8) NOT NULL,
    "connected_by_user_id" UUID NOT NULL,
    "verified_at" TIMESTAMPTZ(3) NOT NULL,
    "last_push_at" TIMESTAMPTZ(3),
    "last_commit_url" VARCHAR(500),
    "last_error" VARCHAR(80),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "code_repositories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "code_repositories_project_id_key" ON "code_repositories"("project_id");
ALTER TABLE "code_repositories" ADD CONSTRAINT "code_repositories_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
