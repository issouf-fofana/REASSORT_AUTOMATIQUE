-- CreateTable
CREATE TABLE "ai_usage_logs" (
    "id" TEXT NOT NULL,
    "provider_key_id" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "prompt_tokens" INTEGER NOT NULL,
    "completion_tokens" INTEGER NOT NULL,
    "total_tokens" INTEGER NOT NULL,
    "context" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_usage_logs_provider_created_at_idx" ON "ai_usage_logs"("provider", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_logs_provider_key_id_created_at_idx" ON "ai_usage_logs"("provider_key_id", "created_at");

-- AddForeignKey
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_provider_key_id_fkey" FOREIGN KEY ("provider_key_id") REFERENCES "ai_provider_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

