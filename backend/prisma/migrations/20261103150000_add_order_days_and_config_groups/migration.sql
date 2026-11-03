-- AlterTable
ALTER TABLE "reassort_configs" ADD COLUMN     "group_id" TEXT,
ADD COLUMN     "order_days" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "reassort_config_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pareto_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.80,
    "safety_stock_ratio" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "period_mode" TEXT NOT NULL DEFAULT 'LAST_365_DAYS',
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
    "weekend_delivery_day" TEXT NOT NULL DEFAULT 'LUNDI',
    "use_reception_lead_time_in_calculation" BOOLEAN NOT NULL DEFAULT false,
    "order_days" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exclude_generic_articles_below_price" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "recent_order_max_age_days" INTEGER NOT NULL DEFAULT 3,
    "forecast_enabled" BOOLEAN NOT NULL DEFAULT false,
    "forecast_alpha" DOUBLE PRECISION NOT NULL DEFAULT 0.3,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "reassort_config_groups_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "reassort_configs" ADD CONSTRAINT "reassort_configs_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "reassort_config_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
