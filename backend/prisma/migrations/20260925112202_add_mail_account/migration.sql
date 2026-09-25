-- CreateTable
CREATE TABLE "mail_accounts" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'OUTLOOK',
    "client_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "encrypted_client_secret" TEXT NOT NULL,
    "encrypted_refresh_token" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_tested_at" TIMESTAMP(3),
    "last_test_success" BOOLEAN,
    "last_error" TEXT,
    "last_error_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mail_accounts_pkey" PRIMARY KEY ("id")
);
