-- Specialist catalog: public profiles and owners' reviews after an accepted stage.
CREATE TABLE "specialist_profiles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "display_name" VARCHAR(80) NOT NULL,
    "headline" VARCHAR(140) NOT NULL,
    "about" VARCHAR(2000),
    "stage_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "hourly_rate_tiyn" INTEGER,
    "city" VARCHAR(80),
    "published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "specialist_profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "specialist_profiles_rate_positive" CHECK ("hourly_rate_tiyn" IS NULL OR "hourly_rate_tiyn" > 0)
);
CREATE UNIQUE INDEX "specialist_profiles_user_id_key" ON "specialist_profiles"("user_id");
CREATE INDEX "specialist_profiles_published_idx" ON "specialist_profiles"("published");
ALTER TABLE "specialist_profiles" ADD CONSTRAINT "specialist_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "specialist_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assignment_id" UUID NOT NULL,
    "specialist_user_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "stage_key" VARCHAR(40) NOT NULL,
    "project_type" VARCHAR(40),
    "rating" SMALLINT NOT NULL,
    "text" VARCHAR(1000),
    "reply" VARCHAR(1000),
    "replied_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "specialist_reviews_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "specialist_reviews_rating_range" CHECK ("rating" BETWEEN 1 AND 5)
);
CREATE UNIQUE INDEX "specialist_reviews_assignment_id_key" ON "specialist_reviews"("assignment_id");
CREATE INDEX "specialist_reviews_specialist_created_idx" ON "specialist_reviews"("specialist_user_id", "created_at" DESC);
ALTER TABLE "specialist_reviews" ADD CONSTRAINT "specialist_reviews_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "stage_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
