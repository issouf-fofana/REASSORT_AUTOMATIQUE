-- AlterTable
ALTER TABLE "sales_backfill_chunks" ADD COLUMN     "retry_count" INTEGER NOT NULL DEFAULT 0;

