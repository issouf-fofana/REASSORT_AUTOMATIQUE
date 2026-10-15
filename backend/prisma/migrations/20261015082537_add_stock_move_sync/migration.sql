-- CreateTable
CREATE TABLE "stock_moves" (
    "id" TEXT NOT NULL,
    "rpos_move_id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "label" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "type_label" TEXT NOT NULL,
    "recording" TEXT,
    "is_scrap" BOOLEAN NOT NULL DEFAULT false,
    "quantity" DOUBLE PRECISION NOT NULL,
    "previous_quantity" DOUBLE PRECISION,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_moves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_move_sync_state" (
    "id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "last_synced_until" TIMESTAMP(3),
    "last_sync_status" TEXT,
    "last_sync_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_move_sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_moves_rpos_move_id_key" ON "stock_moves"("rpos_move_id");

-- CreateIndex
CREATE INDEX "stock_moves_rpos_shop_id_date_idx" ON "stock_moves"("rpos_shop_id", "date");

-- CreateIndex
CREATE INDEX "stock_moves_rpos_shop_id_ean_date_idx" ON "stock_moves"("rpos_shop_id", "ean", "date");

-- CreateIndex
CREATE UNIQUE INDEX "stock_move_sync_state_rpos_shop_id_key" ON "stock_move_sync_state"("rpos_shop_id");
