-- CreateIndex
CREATE INDEX "ai_forecast_lines_run_id_idx" ON "ai_forecast_lines"("run_id");

-- CreateIndex
CREATE INDEX "proposal_lines_proposalId_ean_idx" ON "proposal_lines"("proposalId", "ean");

-- CreateIndex
CREATE INDEX "reception_events_proposalOrderId_idx" ON "reception_events"("proposalOrderId");

