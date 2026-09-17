-- CreateTable
CREATE TABLE "autonomy_readiness_snapshots" (
    "id" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error_rate_score" DOUBLE PRECISION,
    "recommendation_accuracy_score" DOUBLE PRECISION,
    "stability_score" DOUBLE PRECISION,
    "anomaly_detection_score" DOUBLE PRECISION,
    "rule_compliance_score" DOUBLE PRECISION,
    "post_correction_score" DOUBLE PRECISION,
    "test_case_score" DOUBLE PRECISION,
    "global_score" DOUBLE PRECISION NOT NULL,
    "measured_criteria_count" INTEGER NOT NULL,
    "level" TEXT NOT NULL,
    "current_streak_count" INTEGER NOT NULL,
    "details_json" TEXT NOT NULL,

    CONSTRAINT "autonomy_readiness_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "autonomy_readiness_snapshots_computed_at_idx" ON "autonomy_readiness_snapshots"("computed_at");

