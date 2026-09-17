-- AlterTable
ALTER TABLE "sales_backfill_runs" ADD COLUMN     "batch_id" TEXT;

-- CreateTable
CREATE TABLE "sales_backfill_batches" (
    "id" TEXT NOT NULL,
    "targets_json" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "current_index" INTEGER NOT NULL DEFAULT 0,
    "cancel_requested" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_backfill_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_backfill_runs_batch_id_idx" ON "sales_backfill_runs"("batch_id");

-- AddForeignKey
ALTER TABLE "sales_backfill_runs" ADD CONSTRAINT "sales_backfill_runs_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "sales_backfill_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
