-- Plan prices and the upgrade contact are managed by staff in the admin console.
CREATE TABLE "plan_prices" (
    "plan_key" VARCHAR(40) NOT NULL,
    "monthly_price_kzt" INTEGER,
    "updated_by_staff_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plan_prices_pkey" PRIMARY KEY ("plan_key"),
    CONSTRAINT "plan_prices_plan_key_check" CHECK ("plan_key" IN ('start', 'business')),
    CONSTRAINT "plan_prices_amount_check" CHECK ("monthly_price_kzt" IS NULL OR ("monthly_price_kzt" BETWEEN 100 AND 10000000))
);

CREATE TABLE "billing_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "sales_contact_url" VARCHAR(300),
    "updated_by_staff_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "billing_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "billing_settings_singleton_check" CHECK ("id" = 1)
);

-- Starting prices (can be changed in the admin console at any time).
INSERT INTO "plan_prices" ("plan_key", "monthly_price_kzt") VALUES ('start', 4990), ('business', 14990);
INSERT INTO "billing_settings" ("id") VALUES (1);
