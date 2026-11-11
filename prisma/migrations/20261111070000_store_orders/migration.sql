-- Orders from published stores (project type «Небольшой интернет-магазин»).
CREATE TABLE "store_orders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "items_tiyn" INTEGER NOT NULL,
    "delivery_key" VARCHAR(24) NOT NULL,
    "delivery_title" VARCHAR(60) NOT NULL,
    "delivery_tiyn" INTEGER NOT NULL,
    "total_tiyn" INTEGER NOT NULL,
    "payment_method" VARCHAR(20) NOT NULL,
    "client_name" VARCHAR(80) NOT NULL,
    "client_phone" VARCHAR(30) NOT NULL,
    "address" VARCHAR(300),
    "comment" VARCHAR(300),
    "status" VARCHAR(20) NOT NULL DEFAULT 'new',
    "token_hash" VARCHAR(64) NOT NULL,
    "consent_at" TIMESTAMPTZ(3) NOT NULL,
    "ip_hash" VARCHAR(64) NOT NULL,
    "telegram_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "store_orders_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "store_orders_total_check" CHECK ("items_tiyn" >= 0 AND "delivery_tiyn" >= 0 AND "total_tiyn" = "items_tiyn" + "delivery_tiyn")
);
CREATE UNIQUE INDEX "store_orders_token_hash_key" ON "store_orders"("token_hash");
CREATE UNIQUE INDEX "store_orders_project_number_key" ON "store_orders"("project_id", "number");
CREATE INDEX "store_orders_project_created_idx" ON "store_orders"("project_id", "created_at");
CREATE INDEX "store_orders_publication_created_idx" ON "store_orders"("publication_id", "created_at");
ALTER TABLE "store_orders" ADD CONSTRAINT "store_orders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "store_orders" ADD CONSTRAINT "store_orders_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "site_publications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
