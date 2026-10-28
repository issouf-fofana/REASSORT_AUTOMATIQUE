-- AlterTable
ALTER TABLE "proposal_lines" ADD COLUMN "proposal_order_id" TEXT;

-- AddForeignKey
ALTER TABLE "proposal_lines" ADD CONSTRAINT "proposal_lines_proposal_order_id_fkey" FOREIGN KEY ("proposal_order_id") REFERENCES "proposal_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "article_suppliers" (
    "id" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "rpos_supplier_id" TEXT NOT NULL,
    "rpos_supplier_name" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT,

    CONSTRAINT "article_suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "article_suppliers_rpos_shop_id_ean_idx" ON "article_suppliers"("rpos_shop_id", "ean");

-- CreateIndex
CREATE UNIQUE INDEX "article_suppliers_rpos_shop_id_ean_rpos_supplier_id_key" ON "article_suppliers"("rpos_shop_id", "ean", "rpos_supplier_id");
