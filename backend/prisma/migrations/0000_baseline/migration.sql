-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'STORE',
    "rpos_shop_id" TEXT,
    "rpos_shop_reference" TEXT,
    "rpos_shop_name" TEXT,
    "rpos_pos_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supervised_shops" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "rpos_shop_reference" TEXT NOT NULL,
    "rpos_shop_name" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supervised_shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rpos_servers" (
    "id" TEXT NOT NULL,
    "pos_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "base_url" TEXT NOT NULL,
    "rpos_user" TEXT,
    "rpos_password" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rpos_servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_cache" (
    "id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "rpos_product_id" TEXT NOT NULL,
    "orderable" BOOLEAN NOT NULL,
    "selling_price" DOUBLE PRECISION NOT NULL,
    "buying_price" DOUBLE PRECISION NOT NULL,
    "ordering_unit" DOUBLE PRECISION NOT NULL,
    "stock" DOUBLE PRECISION NOT NULL,
    "department_id" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recent_order_cache" (
    "id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "rpos_product_id" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "order_count" INTEGER NOT NULL DEFAULT 0,
    "most_recent_date" TIMESTAMP(3),
    "most_recent_reference" TEXT,
    "most_recent_status" INTEGER,
    "orders_json" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recent_order_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_activity_profile" (
    "id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "profile_json" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_activity_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reassort_configs" (
    "id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "pareto_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.80,
    "safety_stock_ratio" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "period_mode" TEXT NOT NULL DEFAULT 'LAST_30_DAYS',
    "custom_start" TIMESTAMP(3),
    "custom_end" TIMESTAMP(3),
    "treat_negative_stock_as_zero" BOOLEAN NOT NULL DEFAULT true,
    "ignore_rpos_stock_in_calculation" BOOLEAN NOT NULL DEFAULT false,
    "revenue_share_period_days" INTEGER NOT NULL DEFAULT 1,
    "overstock_threshold_multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.5,
    "split_orders_by_department" BOOLEAN NOT NULL DEFAULT true,
    "forecast_accuracy_window_days" INTEGER NOT NULL DEFAULT 7,
    "forecast_accuracy_threshold_pct" DOUBLE PRECISION NOT NULL DEFAULT 20,
    "seasonality_comparison_enabled" BOOLEAN NOT NULL DEFAULT false,
    "seasonality_lookback_years" INTEGER NOT NULL DEFAULT 1,
    "seasonality_adjustment_threshold_pct" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "reception_lead_time_days" INTEGER NOT NULL DEFAULT 1,
    "use_reception_lead_time_in_calculation" BOOLEAN NOT NULL DEFAULT false,
    "exclude_generic_articles_below_price" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "recent_order_max_age_days" INTEGER NOT NULL DEFAULT 3,
    "forecast_enabled" BOOLEAN NOT NULL DEFAULT false,
    "forecast_alpha" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "reassort_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_generation_run" (
    "id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "step" TEXT NOT NULL DEFAULT 'SALES',
    "articles_total" INTEGER NOT NULL DEFAULT 0,
    "articles_processed" INTEGER NOT NULL DEFAULT 0,
    "last_article_ean" TEXT,
    "last_article_label" TEXT,
    "proposal_id" TEXT,
    "error_message" TEXT,
    "ai_unavailable" BOOLEAN,
    "ai_articles_adjusted" INTEGER,
    "ai_error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "proposal_generation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposals" (
    "id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "rpos_shop_reference" TEXT NOT NULL,
    "rpos_shop_name" TEXT NOT NULL,
    "rpos_pos_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'GENERATED',
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validated_at" TIMESTAMP(3),
    "validated_by" TEXT,
    "lines_total" INTEGER,
    "lines_processed" INTEGER,
    "lines_failed" INTEGER,
    "validation_error" TEXT,
    "rpos_order_id" TEXT,
    "rpos_order_reference" TEXT,
    "rpos_order_validated" BOOLEAN,
    "revenue_share_start" TIMESTAMP(3),
    "revenue_share_end" TIMESTAMP(3),
    "shop_total_revenue" DOUBLE PRECISION,
    "analysis_period_start" TIMESTAMP(3),
    "analysis_period_end" TIMESTAMP(3),
    "analysis_period_mode" TEXT,
    "actual_data_start" TIMESTAMP(3),
    "actual_data_end" TIMESTAMP(3),
    "coverage_gap_days" INTEGER DEFAULT 0,
    "pareto_threshold_used" DOUBLE PRECISION,
    "safety_stock_ratio_used" DOUBLE PRECISION,
    "reception_lead_time_days_used" INTEGER,
    "total_articles_with_sales" INTEGER,
    "skipped_not_found" INTEGER,
    "skipped_not_orderable" INTEGER,
    "skipped_negative_stock" INTEGER,
    "skipped_already_ordered" INTEGER,
    "skipped_generic_article" INTEGER,
    "weekly_plan_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_replenishment_plans" (
    "id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "rpos_shop_reference" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "target_week_start" TIMESTAMP(3) NOT NULL,
    "target_week_end" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_replenishment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_predictions" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "label" TEXT,
    "prediction_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "target_period_start" TIMESTAMP(3),
    "target_period_end" TIMESTAMP(3),
    "predicted_weekly_demand" DOUBLE PRECISION NOT NULL,
    "predicted_daily_demand" DOUBLE PRECISION NOT NULL,
    "predicted_quantity" INTEGER NOT NULL,
    "stock_at_prediction" DOUBLE PRECISION NOT NULL,
    "orders_at_prediction" DOUBLE PRECISION NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'smoothing',
    "model_version" TEXT,
    "confidence_score" DOUBLE PRECISION,
    "reasoning" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_prediction_outcomes" (
    "id" TEXT NOT NULL,
    "prediction_id" TEXT NOT NULL,
    "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "predicted_quantity" INTEGER NOT NULL,
    "actual_sales" DOUBLE PRECISION NOT NULL,
    "actual_stock" DOUBLE PRECISION,
    "actual_orders" DOUBLE PRECISION,
    "forecast_error" DOUBLE PRECISION NOT NULL,
    "absolute_error" DOUBLE PRECISION NOT NULL,
    "percentage_error" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_prediction_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "excluded_articles" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "label" TEXT,
    "revenue_share_pct" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,

    CONSTRAINT "excluded_articles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_orders" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "rpos_order_id" TEXT,
    "rpos_order_reference" TEXT,
    "rpos_order_validated" BOOLEAN,
    "lines_total" INTEGER NOT NULL DEFAULT 0,
    "lines_failed" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "reception_status" TEXT NOT NULL DEFAULT 'COMMANDEE',
    "expected_reception_date" TIMESTAMP(3),
    "actual_reception_date" TIMESTAMP(3),
    "last_rpos_status" INTEGER,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reception_events" (
    "id" TEXT NOT NULL,
    "proposalOrderId" TEXT NOT NULL,
    "rposStatus" INTEGER NOT NULL,
    "receptionStatus" TEXT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reception_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposal_lines" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rpos_product_id" TEXT NOT NULL,
    "quantity_suggested" DOUBLE PRECISION NOT NULL,
    "quantity_validated" DOUBLE PRECISION,
    "classic_quantity_suggested" DOUBLE PRECISION,
    "ai_adjusted" BOOLEAN NOT NULL DEFAULT false,
    "ai_reasoning" TEXT,
    "stock_at_generation" DOUBLE PRECISION,
    "avg_weekly_sales" DOUBLE PRECISION,
    "days_until_stockout" DOUBLE PRECISION,
    "selling_price" DOUBLE PRECISION,
    "buying_price" DOUBLE PRECISION,
    "revenue_share_pct" DOUBLE PRECISION,
    "had_negative_stock" BOOLEAN NOT NULL DEFAULT false,
    "actual_stock" DOUBLE PRECISION,
    "department" TEXT,
    "sector" TEXT,
    "was_excluded" BOOLEAN NOT NULL DEFAULT false,
    "actual_sales_quantity" DOUBLE PRECISION,
    "actual_sales_fetched_at" TIMESTAMP(3),
    "current_ordered_quantity" DOUBLE PRECISION,
    "ordering_unit" DOUBLE PRECISION,
    "cumulative_pct" DOUBLE PRECISION,
    "excluded_as_already_ordered" BOOLEAN NOT NULL DEFAULT false,
    "platform_order_reference" TEXT,
    "platform_order_date" TIMESTAMP(3),
    "excluded_as_already_ordered_rpos" BOOLEAN NOT NULL DEFAULT false,
    "rpos_order_reference" TEXT,
    "rpos_order_date" TIMESTAMP(3),
    "rpos_order_count" INTEGER,
    "rpos_order_status" INTEGER,
    "quantity_if_unblocked" DOUBLE PRECISION,
    "quantity_in_transit" DOUBLE PRECISION,
    "seasonality_adjusted" BOOLEAN NOT NULL DEFAULT false,
    "seasonality_deviation_pct" DOUBLE PRECISION,
    "forecast_method" TEXT NOT NULL DEFAULT 'flat',
    "daily_history" TEXT,
    "anomalies" TEXT,
    "trend_category" TEXT,
    "trend_change_pct" DOUBLE PRECISION,

    CONSTRAINT "proposal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_config" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_insight_cache" (
    "id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "rpos_product_id" TEXT NOT NULL,
    "last_purchase_date" TIMESTAMP(3),
    "last_purchase_quantity" DOUBLE PRECISION,
    "last_purchase_order_ref" TEXT,
    "last_sale_date" TIMESTAMP(3),
    "last_sale_quantity" DOUBLE PRECISION,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_insight_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_lines" (
    "id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "label" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "revenue_excl_tax" DOUBLE PRECISION NOT NULL,
    "revenue_incl_tax" DOUBLE PRECISION,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dedup_key" TEXT NOT NULL,

    CONSTRAINT "sales_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_sync_state" (
    "id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "last_synced_until" TIMESTAMP(3),
    "last_sync_status" TEXT,
    "last_sync_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_backfill_runs" (
    "id" TEXT NOT NULL,
    "rpos_pos_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "estimated_total_lines" INTEGER NOT NULL,
    "total_chunks" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "pause_requested" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_backfill_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_backfill_chunks" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "expected_lines" INTEGER NOT NULL DEFAULT 0,
    "fetched_lines" INTEGER NOT NULL DEFAULT 0,
    "last_page_completed" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_backfill_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_provider_keys" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "encrypted_api_key" TEXT NOT NULL,
    "model" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "last_error" TEXT,
    "last_error_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,

    CONSTRAINT "ai_provider_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_forecast_runs" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "provider_used" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error_message" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "requested_by" TEXT,

    CONSTRAINT "ai_forecast_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_forecast_lines" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "ean" TEXT NOT NULL,
    "label" TEXT,
    "quantity_suggested" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT,

    CONSTRAINT "ai_forecast_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chatbot_conversations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "department" TEXT,
    "sub_department" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chatbot_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chatbot_messages" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "tool_used" TEXT,
    "tool_result" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chatbot_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_improvements" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "dev_recommendation" TEXT,
    "evidence" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "applied_at" TIMESTAMP(3),
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "error_message" TEXT,
    "ai_confidence" INTEGER,
    "metric_name" TEXT,
    "metric_before" DOUBLE PRECISION,
    "metric_after" DOUBLE PRECISION,
    "provider_used" TEXT,
    "ai_prompt" TEXT,
    "ai_error" TEXT,
    "detected_by" TEXT,
    "detected_ip" TEXT,
    "app_version" TEXT,
    "environment" TEXT DEFAULT 'production',
    "applied_by" TEXT,
    "applied_note" TEXT,
    "dismissed_by" TEXT,
    "dismissed_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_improvements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_improvement_events" (
    "id" TEXT NOT NULL,
    "improvement_id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "action" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "note" TEXT,

    CONSTRAINT "ai_improvement_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "error_reports" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "page" TEXT,
    "url" TEXT,
    "method" TEXT,
    "status_code" INTEGER,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "user_email" TEXT,
    "shop_ref" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "improvement_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "supervised_shops_userId_rpos_shop_id_key" ON "supervised_shops"("userId", "rpos_shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "rpos_servers_pos_id_key" ON "rpos_servers"("pos_id");

-- CreateIndex
CREATE UNIQUE INDEX "shops_rpos_shop_id_key" ON "shops"("rpos_shop_id");

-- CreateIndex
CREATE INDEX "shops_rpos_pos_id_idx" ON "shops"("rpos_pos_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_cache_rpos_shop_id_ean_key" ON "product_cache"("rpos_shop_id", "ean");

-- CreateIndex
CREATE UNIQUE INDEX "recent_order_cache_rpos_shop_id_rpos_product_id_key" ON "recent_order_cache"("rpos_shop_id", "rpos_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "shop_activity_profile_rpos_shop_id_key" ON "shop_activity_profile"("rpos_shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "reassort_configs_rpos_shop_id_key" ON "reassort_configs"("rpos_shop_id");

-- CreateIndex
CREATE INDEX "proposal_generation_run_rpos_shop_id_created_at_idx" ON "proposal_generation_run"("rpos_shop_id", "created_at");

-- CreateIndex
CREATE INDEX "proposals_rpos_shop_id_generated_at_idx" ON "proposals"("rpos_shop_id", "generated_at");

-- CreateIndex
CREATE INDEX "proposals_rpos_shop_id_status_validated_at_idx" ON "proposals"("rpos_shop_id", "status", "validated_at");

-- CreateIndex
CREATE INDEX "proposals_weekly_plan_id_idx" ON "proposals"("weekly_plan_id");

-- CreateIndex
CREATE INDEX "weekly_replenishment_plans_rpos_shop_id_status_idx" ON "weekly_replenishment_plans"("rpos_shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_replenishment_plans_rpos_shop_id_target_week_start_key" ON "weekly_replenishment_plans"("rpos_shop_id", "target_week_start");

-- CreateIndex
CREATE INDEX "ai_predictions_rpos_shop_id_ean_prediction_date_idx" ON "ai_predictions"("rpos_shop_id", "ean", "prediction_date");

-- CreateIndex
CREATE INDEX "ai_predictions_proposal_id_idx" ON "ai_predictions"("proposal_id");

-- CreateIndex
CREATE UNIQUE INDEX "ai_prediction_outcomes_prediction_id_key" ON "ai_prediction_outcomes"("prediction_id");

-- CreateIndex
CREATE INDEX "ai_prediction_outcomes_evaluated_at_idx" ON "ai_prediction_outcomes"("evaluated_at");

-- CreateIndex
CREATE INDEX "excluded_articles_proposal_id_reason_idx" ON "excluded_articles"("proposal_id", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "system_config_key_key" ON "system_config"("key");

-- CreateIndex
CREATE UNIQUE INDEX "product_insight_cache_rpos_pos_id_rpos_shop_id_rpos_product_key" ON "product_insight_cache"("rpos_pos_id", "rpos_shop_id", "rpos_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_lines_dedup_key_key" ON "sales_lines"("dedup_key");

-- CreateIndex
CREATE INDEX "sales_lines_rpos_shop_id_date_idx" ON "sales_lines"("rpos_shop_id", "date");

-- CreateIndex
CREATE INDEX "sales_lines_rpos_shop_id_ean_date_idx" ON "sales_lines"("rpos_shop_id", "ean", "date");

-- CreateIndex
CREATE UNIQUE INDEX "sales_sync_state_rpos_shop_id_key" ON "sales_sync_state"("rpos_shop_id");

-- CreateIndex
CREATE INDEX "sales_backfill_runs_rpos_shop_id_status_idx" ON "sales_backfill_runs"("rpos_shop_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_backfill_chunks_run_id_chunk_index_key" ON "sales_backfill_chunks"("run_id", "chunk_index");

-- CreateIndex
CREATE INDEX "chatbot_conversations_user_id_updated_at_idx" ON "chatbot_conversations"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "chatbot_messages_conversation_id_created_at_idx" ON "chatbot_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_improvements_status_created_at_idx" ON "ai_improvements"("status", "created_at");

-- CreateIndex
CREATE INDEX "ai_improvements_type_scope_status_idx" ON "ai_improvements"("type", "scope", "status");

-- CreateIndex
CREATE INDEX "ai_improvements_priority_status_idx" ON "ai_improvements"("priority", "status");

-- CreateIndex
CREATE INDEX "ai_improvement_events_improvement_id_at_idx" ON "ai_improvement_events"("improvement_id", "at");

-- CreateIndex
CREATE INDEX "error_reports_source_created_at_idx" ON "error_reports"("source", "created_at");

-- CreateIndex
CREATE INDEX "error_reports_created_at_idx" ON "error_reports"("created_at");

-- AddForeignKey
ALTER TABLE "supervised_shops" ADD CONSTRAINT "supervised_shops_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_weekly_plan_id_fkey" FOREIGN KEY ("weekly_plan_id") REFERENCES "weekly_replenishment_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_predictions" ADD CONSTRAINT "ai_predictions_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_prediction_outcomes" ADD CONSTRAINT "ai_prediction_outcomes_prediction_id_fkey" FOREIGN KEY ("prediction_id") REFERENCES "ai_predictions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "excluded_articles" ADD CONSTRAINT "excluded_articles_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_orders" ADD CONSTRAINT "proposal_orders_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reception_events" ADD CONSTRAINT "reception_events_proposalOrderId_fkey" FOREIGN KEY ("proposalOrderId") REFERENCES "proposal_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_lines" ADD CONSTRAINT "proposal_lines_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_backfill_chunks" ADD CONSTRAINT "sales_backfill_chunks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "sales_backfill_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_forecast_lines" ADD CONSTRAINT "ai_forecast_lines_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ai_forecast_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chatbot_messages" ADD CONSTRAINT "chatbot_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "chatbot_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_improvement_events" ADD CONSTRAINT "ai_improvement_events_improvement_id_fkey" FOREIGN KEY ("improvement_id") REFERENCES "ai_improvements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "error_reports" ADD CONSTRAINT "error_reports_improvement_id_fkey" FOREIGN KEY ("improvement_id") REFERENCES "ai_improvements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

