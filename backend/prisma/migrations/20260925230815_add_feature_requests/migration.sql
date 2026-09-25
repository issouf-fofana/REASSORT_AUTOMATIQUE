-- CreateTable
CREATE TABLE "feature_requests" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "expectedBehavior" TEXT,
    "context" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "related_request_ids_json" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "feature_request_notes" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "user_id" TEXT,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feature_request_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feature_requests_status_created_at_idx" ON "feature_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "feature_request_notes_request_id_created_at_idx" ON "feature_request_notes"("request_id", "created_at");

-- AddForeignKey
ALTER TABLE "feature_request_notes" ADD CONSTRAINT "feature_request_notes_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "feature_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "feature_request_notes" ADD CONSTRAINT "feature_request_notes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
