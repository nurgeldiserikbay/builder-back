-- Refunds: the unspent part of a top-up on request; money held for a specialist returned to the owner by staff.
ALTER TABLE "project_top_ups"
  ADD COLUMN "refunded_tiyn" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "refund_status" VARCHAR(10),
  ADD COLUMN "refund_requested_tiyn" INTEGER,
  ADD COLUMN "refund_reason" VARCHAR(300),
  ADD COLUMN "refund_requested_at" TIMESTAMPTZ(3),
  ADD COLUMN "refund_decided_at" TIMESTAMPTZ(3),
  ADD COLUMN "refund_decided_by_staff_id" UUID,
  ADD COLUMN "refund_reference" VARCHAR(100),
  ADD COLUMN "refund_note" VARCHAR(300),
  ADD CONSTRAINT "project_top_ups_refund_status_check" CHECK ("refund_status" IS NULL OR "refund_status" IN ('requested', 'refunded', 'rejected')),
  ADD CONSTRAINT "project_top_ups_refunded_check" CHECK ("refunded_tiyn" >= 0 AND "refunded_tiyn" <= "amount_tiyn"),
  ADD CONSTRAINT "project_top_ups_refund_requested_check" CHECK ("refund_requested_tiyn" IS NULL OR ("refund_requested_tiyn" > 0 AND "refund_requested_tiyn" <= "amount_tiyn"));
CREATE INDEX "project_top_ups_refund_status_idx" ON "project_top_ups" ("refund_status");

ALTER TABLE "stage_payments"
  ADD COLUMN "refunded_at" TIMESTAMPTZ(3),
  ADD COLUMN "refund_reference" VARCHAR(100),
  ADD COLUMN "refund_note" VARCHAR(300),
  DROP CONSTRAINT "stage_payments_status_check",
  ADD CONSTRAINT "stage_payments_status_check" CHECK ("status" IN ('due', 'checkout', 'held', 'paid_out', 'paid_direct', 'paid', 'cancelled', 'refunded'));
