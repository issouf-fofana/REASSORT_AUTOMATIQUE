-- DropIndex
DROP INDEX "proposal_orders_proposalId_department_key";

-- AlterTable
ALTER TABLE "proposal_lines" ADD COLUMN     "delivery_type" TEXT,
ADD COLUMN     "resolved_supplier_id" TEXT,
ADD COLUMN     "resolved_supplier_name" TEXT,
ADD COLUMN     "supplier_resolution_origin" TEXT;

-- AlterTable
ALTER TABLE "proposal_orders" ADD COLUMN     "delivery_type" TEXT,
ADD COLUMN     "supplier_id" TEXT,
ADD COLUMN     "supplier_name" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "proposal_orders_proposalId_department_supplier_id_key" ON "proposal_orders"("proposalId", "department", "supplier_id");

