-- CreateTable
CREATE TABLE "stock_snapshots" (
    "id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "stock" DOUBLE PRECISION NOT NULL,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stockout_episodes" (
    "id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "label" TEXT,
    "department" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'EN_COURS',
    "cause_proposee" TEXT NOT NULL,
    "niveau_confiance" TEXT NOT NULL,
    "commande_ref_utile" TEXT,
    "qty_perdue_estimee" DOUBLE PRECISION,
    "ca_perdue_estime" DOUBLE PRECISION,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stockout_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_snapshots_rpos_shop_id_ean_captured_at_idx" ON "stock_snapshots"("rpos_shop_id", "ean", "captured_at");

-- CreateIndex
CREATE INDEX "stock_snapshots_rpos_shop_id_captured_at_idx" ON "stock_snapshots"("rpos_shop_id", "captured_at");

-- CreateIndex
CREATE INDEX "stockout_episodes_rpos_shop_id_status_idx" ON "stockout_episodes"("rpos_shop_id", "status");

-- CreateIndex
CREATE INDEX "stockout_episodes_rpos_shop_id_ean_status_idx" ON "stockout_episodes"("rpos_shop_id", "ean", "status");
