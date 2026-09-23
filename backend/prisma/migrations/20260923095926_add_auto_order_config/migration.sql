-- AlterTable
ALTER TABLE "reassort_configs" ADD COLUMN     "auto_order_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "auto_order_validate_after_create" BOOLEAN NOT NULL DEFAULT false;
