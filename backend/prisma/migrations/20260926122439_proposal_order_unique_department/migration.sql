-- CreateIndex
CREATE UNIQUE INDEX "proposal_orders_proposalId_department_key" ON "proposal_orders"("proposalId", "department");
