CREATE TABLE "supplier_order_cache" (
    "id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_order_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "external_reference" TEXT,
    "date" TIMESTAMP(3),
    "delivery_date" TIMESTAMP(3),
    "status_display" TEXT NOT NULL,
    "supplier_code" TEXT,
    "supplier_name" TEXT,
    "created_by" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_order_cache_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supplier_order_cache_rposShopId_rposOrderId_key" ON "supplier_order_cache"("rpos_shop_id", "rpos_order_id");

CREATE INDEX "supplier_order_cache_rposShopId_rposPosId_idx" ON "supplier_order_cache"("rpos_shop_id", "rpos_pos_id");
