-- Disputes about a specialist's stage, decided by staff. One open dispute per assignment; while it is open, payouts for that assignment are blocked in the service.
CREATE TABLE "disputes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "assignment_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "opened_by_user_id" UUID NOT NULL,
    "opened_by_side" VARCHAR(12) NOT NULL,
    "kind" VARCHAR(12) NOT NULL,
    "claim" VARCHAR(2000) NOT NULL,
    "claim_amount_tiyn" INTEGER,
    "status" VARCHAR(12) NOT NULL DEFAULT 'open',
    "outcome" VARCHAR(12),
    "resolution_note" VARCHAR(1000),
    "result_payment_id" UUID,
    "resolved_by_staff_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "disputes_side_check" CHECK ("opened_by_side" IN ('owner', 'specialist')),
    CONSTRAINT "disputes_kind_check" CHECK ("kind" IN ('payment', 'refund', 'quality', 'other')),
    CONSTRAINT "disputes_status_check" CHECK ("status" IN ('open', 'resolved', 'withdrawn')),
    CONSTRAINT "disputes_outcome_check" CHECK ("outcome" IS NULL OR "outcome" IN ('specialist', 'owner', 'split', 'no_change')),
    CONSTRAINT "disputes_claim_amount_positive" CHECK ("claim_amount_tiyn" IS NULL OR "claim_amount_tiyn" > 0)
);
CREATE INDEX "disputes_status_created_idx" ON "disputes"("status", "created_at");
CREATE INDEX "disputes_assignment_idx" ON "disputes"("assignment_id");
CREATE UNIQUE INDEX "disputes_one_open_per_assignment" ON "disputes"("assignment_id") WHERE "status" = 'open';
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "stage_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "dispute_messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "dispute_id" UUID NOT NULL,
    "side" VARCHAR(12) NOT NULL,
    "author_user_id" UUID,
    "staff_id" UUID,
    "text" VARCHAR(2000) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dispute_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "dispute_messages_side_check" CHECK ("side" IN ('owner', 'specialist', 'staff'))
);
CREATE INDEX "dispute_messages_dispute_created_idx" ON "dispute_messages"("dispute_id", "created_at");
ALTER TABLE "dispute_messages" ADD CONSTRAINT "dispute_messages_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
