-- AlterTable
ALTER TABLE "ai_predictions" ADD COLUMN     "action" TEXT;

-- AlterTable
ALTER TABLE "proposal_lines" ADD COLUMN     "ai_action" TEXT;
