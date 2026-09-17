-- CreateTable
CREATE TABLE "correction_records" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "improvement_id" TEXT,
    "domain" TEXT NOT NULL,
    "error_observed" TEXT NOT NULL,
    "context" TEXT NOT NULL,
    "root_cause" TEXT NOT NULL,
    "fix_applied" TEXT NOT NULL,
    "files_changed" TEXT NOT NULL,
    "functions_changed" TEXT NOT NULL,
    "tests_before" TEXT NOT NULL,
    "tests_after" TEXT NOT NULL,
    "similar_past_correction_ids" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" TEXT NOT NULL DEFAULT 'system',

    CONSTRAINT "correction_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "correction_records_domain_idx" ON "correction_records"("domain");

-- CreateIndex
CREATE INDEX "correction_records_source_idx" ON "correction_records"("source");

-- CreateIndex
CREATE INDEX "correction_records_created_at_idx" ON "correction_records"("created_at");

-- AddForeignKey
ALTER TABLE "correction_records" ADD CONSTRAINT "correction_records_improvement_id_fkey" FOREIGN KEY ("improvement_id") REFERENCES "ai_improvements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

