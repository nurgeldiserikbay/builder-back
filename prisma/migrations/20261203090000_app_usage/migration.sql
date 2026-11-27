-- Usage analytics of launched applications: daily counters only; visitors counted with a daily salt deleted with them.
CREATE TABLE "usage_collectors" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "token" VARCHAR(48) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "usage_collectors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "usage_collectors_project_id_key" ON "usage_collectors"("project_id");
CREATE UNIQUE INDEX "usage_collectors_token_key" ON "usage_collectors"("token");
ALTER TABLE "usage_collectors" ADD CONSTRAINT "usage_collectors_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "usage_days" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "collector_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "kind" VARCHAR(8) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "usage_days_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "usage_days_collector_id_day_kind_name_key" ON "usage_days"("collector_id", "day", "kind", "name");
CREATE INDEX "usage_days_collector_id_day_idx" ON "usage_days"("collector_id", "day");
ALTER TABLE "usage_days" ADD CONSTRAINT "usage_days_collector_id_fkey" FOREIGN KEY ("collector_id") REFERENCES "usage_collectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "usage_visitors" (
    "collector_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "hash" CHAR(32) NOT NULL,
    CONSTRAINT "usage_visitors_pkey" PRIMARY KEY ("collector_id", "day", "hash")
);

CREATE TABLE "usage_salts" (
    "day" DATE NOT NULL,
    "salt" CHAR(64) NOT NULL,
    CONSTRAINT "usage_salts_pkey" PRIMARY KEY ("day")
);
