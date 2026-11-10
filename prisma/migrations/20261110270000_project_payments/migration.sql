-- Prepaid project balance: billing mode in the pricing singleton and top-ups through a payment provider.
ALTER TABLE "ai_pricing" ADD COLUMN "billing_mode" VARCHAR(10) NOT NULL DEFAULT 'off';
ALTER TABLE "ai_pricing" ADD COLUMN "prepaid_since" TIMESTAMPTZ(3);
ALTER TABLE "ai_pricing" ADD COLUMN "min_top_up_tiyn" INTEGER NOT NULL DEFAULT 100000;
ALTER TABLE "ai_pricing" ADD CONSTRAINT "ai_pricing_billing_mode_check" CHECK ("billing_mode" IN ('off', 'prepaid'));

CREATE TABLE "project_top_ups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "amount_tiyn" INTEGER NOT NULL,
  "provider" VARCHAR(20) NOT NULL,
  "status" VARCHAR(10) NOT NULL DEFAULT 'created',
  "provider_payment_id" VARCHAR(64),
  "paid_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_top_ups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "project_top_ups_amount_check" CHECK ("amount_tiyn" > 0),
  CONSTRAINT "project_top_ups_status_check" CHECK ("status" IN ('created', 'paid', 'failed', 'expired'))
);
CREATE INDEX "project_top_ups_project_status_idx" ON "project_top_ups"("project_id", "status");
ALTER TABLE "project_top_ups" ADD CONSTRAINT "project_top_ups_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
