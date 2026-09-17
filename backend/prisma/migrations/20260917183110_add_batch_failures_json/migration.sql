-- AlterTable
ALTER TABLE "sales_backfill_batches" ADD COLUMN     "failures_json" TEXT NOT NULL DEFAULT '[]';
