-- Customer prices for AI usage and the cost of each request.
ALTER TABLE "generation_runs" ADD COLUMN "cost_tiyn" INTEGER;
CREATE TABLE "ai_pricing" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "input_per_million_tiyn" INTEGER NOT NULL,
    "output_per_million_tiyn" INTEGER NOT NULL,
    "updated_by_staff_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ai_pricing_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_pricing_single_row" CHECK ("id" = 1),
    CONSTRAINT "ai_pricing_non_negative" CHECK ("input_per_million_tiyn" >= 0 AND "output_per_million_tiyn" >= 0)
);
