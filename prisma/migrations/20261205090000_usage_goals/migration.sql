-- Success goals of the idea review measured by the usage counters.
ALTER TABLE "usage_collectors" ADD COLUMN "goals" JSONB NOT NULL DEFAULT '[]';
