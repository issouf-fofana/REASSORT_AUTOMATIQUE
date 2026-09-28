-- AlterTable
ALTER TABLE "proposal_lines" ADD COLUMN     "current_suppliers" TEXT,
ADD COLUMN     "supplier_ineligible" BOOLEAN;
