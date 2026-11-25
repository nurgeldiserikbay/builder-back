-- «Запрос к этапу»: a question or a needed change raised from a later stage to an earlier one, possibly blocking.
-- A question is answered; a change reopens the earlier stage and is resolved when that stage is accepted again.
CREATE TYPE "ChangeProposalKind" AS ENUM ('change', 'question');
ALTER TYPE "ChangeProposalStatus" ADD VALUE IF NOT EXISTS 'answered';
ALTER TYPE "ChangeProposalStatus" ADD VALUE IF NOT EXISTS 'resolved';
ALTER TABLE "change_proposals"
  ADD COLUMN "kind" "ChangeProposalKind" NOT NULL DEFAULT 'change',
  ADD COLUMN "blocking" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "answer" VARCHAR(1000),
  ADD COLUMN "resolved_version_id" UUID;
CREATE INDEX "change_proposals_from_stage_idx" ON "change_proposals" ("from_stage_id", "status");
