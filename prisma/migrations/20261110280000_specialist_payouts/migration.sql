-- Paying specialists through BuildPath: platform fee, payment through the provider, payout to the specialist's IBAN.
ALTER TABLE "ai_pricing" ADD COLUMN "specialist_fee_bp" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ai_pricing" ADD CONSTRAINT "ai_pricing_specialist_fee_check" CHECK ("specialist_fee_bp" BETWEEN 0 AND 3000);

ALTER TABLE "stage_payments" ADD COLUMN "fee_tiyn" INTEGER;
ALTER TABLE "stage_payments" ADD COLUMN "payout_tiyn" INTEGER;
ALTER TABLE "stage_payments" ADD COLUMN "provider" VARCHAR(20);
ALTER TABLE "stage_payments" ADD COLUMN "provider_payment_id" VARCHAR(64);
ALTER TABLE "stage_payments" ADD COLUMN "held_at" TIMESTAMPTZ(3);
ALTER TABLE "stage_payments" ADD COLUMN "paid_out_at" TIMESTAMPTZ(3);
ALTER TABLE "stage_payments" ADD COLUMN "payout_reference" VARCHAR(100);
ALTER TABLE "stage_payments" ADD COLUMN "paid_out_by_staff_id" UUID;
ALTER TABLE "stage_payments" ADD CONSTRAINT "stage_payments_status_check" CHECK ("status" IN ('due', 'checkout', 'held', 'paid_out', 'paid_direct', 'paid', 'cancelled'));

CREATE TABLE "payout_details" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "holder_name" VARCHAR(120) NOT NULL,
  "iban_encrypted" TEXT NOT NULL,
  "iban_hint" VARCHAR(8) NOT NULL,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payout_details_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "payout_details_user_key" ON "payout_details"("user_id");
ALTER TABLE "payout_details" ADD CONSTRAINT "payout_details_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
