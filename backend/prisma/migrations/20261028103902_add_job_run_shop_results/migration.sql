-- CreateTable
CREATE TABLE "job_run_shop_results" (
    "id" TEXT NOT NULL,
    "job_run_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "shop_label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'success',
    "detail" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "job_run_shop_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_run_shop_results_job_run_id_idx" ON "job_run_shop_results"("job_run_id");

-- CreateIndex
CREATE INDEX "job_run_shop_results_job_run_id_status_idx" ON "job_run_shop_results"("job_run_id", "status");

-- AddForeignKey
ALTER TABLE "job_run_shop_results" ADD CONSTRAINT "job_run_shop_results_job_run_id_fkey" FOREIGN KEY ("job_run_id") REFERENCES "job_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
