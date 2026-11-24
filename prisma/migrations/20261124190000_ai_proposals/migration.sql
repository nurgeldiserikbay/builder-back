-- «Изменить через ИИ» with a preview: the AI answer is kept as a proposal until the person applies or dismisses it.
ALTER TABLE "generation_runs" ADD COLUMN "proposal" JSONB;
ALTER TABLE "generation_runs" ADD COLUMN "proposal_state" VARCHAR(10);
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_proposal_state_check" CHECK ("proposal_state" IS NULL OR "proposal_state" IN ('open', 'applied', 'dismissed'));
