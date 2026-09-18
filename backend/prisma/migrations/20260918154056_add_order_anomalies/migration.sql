-- CreateTable
CREATE TABLE "order_anomalies" (
    "id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "label" TEXT,
    "proposal_id" TEXT,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "new_quantity" DOUBLE PRECISION NOT NULL,
    "historical_mean" DOUBLE PRECISION NOT NULL,
    "historical_min" DOUBLE PRECISION NOT NULL,
    "historical_max" DOUBLE PRECISION NOT NULL,
    "sample_size" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "context_note" TEXT,

    CONSTRAINT "order_anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_anomalies_rpos_shop_id_ean_idx" ON "order_anomalies"("rpos_shop_id", "ean");

-- CreateIndex
CREATE INDEX "order_anomalies_status_detected_at_idx" ON "order_anomalies"("status", "detected_at");

-- AddForeignKey
ALTER TABLE "order_anomalies" ADD CONSTRAINT "order_anomalies_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

