-- AlterTable
ALTER TABLE "proposal_generation_run" ADD COLUMN     "run_type" TEXT NOT NULL DEFAULT 'GENERATE';

-- CreateTable
CREATE TABLE "sales_analyses" (
    "id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "rpos_shop_reference" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "period_mode" TEXT NOT NULL,
    "actual_data_start" TIMESTAMP(3),
    "actual_data_end" TIMESTAMP(3),
    "total_articles_with_sales" INTEGER NOT NULL,
    "sales_source" TEXT NOT NULL,
    "analyzed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_analyses_rpos_shop_id_key" ON "sales_analyses"("rpos_shop_id");
