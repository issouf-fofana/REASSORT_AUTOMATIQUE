-- CreateTable
CREATE TABLE "ai_domain_mastery" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "mastery_score" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "method" TEXT NOT NULL DEFAULT 'CORRECTION_VOLUME',
    "total_observations" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "correction_count" INTEGER NOT NULL DEFAULT 0,
    "known_issues_json" TEXT,
    "last_evaluated_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_domain_mastery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_domain_mastery_domain_key" ON "ai_domain_mastery"("domain");

