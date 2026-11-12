-- Owner's cap on AI spending for a project (tiyn); NULL means no cap.
ALTER TABLE "projects" ADD COLUMN "ai_spend_limit_tiyn" INTEGER;
ALTER TABLE "projects" ADD CONSTRAINT "projects_ai_spend_limit_positive" CHECK ("ai_spend_limit_tiyn" IS NULL OR "ai_spend_limit_tiyn" > 0);
