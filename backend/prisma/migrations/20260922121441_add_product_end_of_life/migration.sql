-- CreateTable
CREATE TABLE "product_end_of_life" (
    "id" TEXT NOT NULL,
    "rpos_id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "dlv_ean" TEXT NOT NULL,
    "origin_ean" TEXT NOT NULL,
    "label" TEXT,
    "dlv_stock" DOUBLE PRECISION NOT NULL,
    "selling_price" DOUBLE PRECISION,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_end_of_life_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_end_of_life_rpos_id_key" ON "product_end_of_life"("rpos_id");

-- CreateIndex
CREATE INDEX "product_end_of_life_rpos_shop_id_origin_ean_idx" ON "product_end_of_life"("rpos_shop_id", "origin_ean");
