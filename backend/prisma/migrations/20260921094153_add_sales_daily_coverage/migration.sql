-- CreateTable
CREATE TABLE "sales_daily_coverage" (
    "id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "expected_lines" INTEGER NOT NULL,
    "actual_lines" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_daily_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_daily_coverage_rpos_shop_id_status_idx" ON "sales_daily_coverage"("rpos_shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_daily_coverage_rpos_shop_id_day_key" ON "sales_daily_coverage"("rpos_shop_id", "day");

