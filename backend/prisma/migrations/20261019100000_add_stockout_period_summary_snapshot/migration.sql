-- Précalcul de "Analyse des pertes sur une période" (demande explicite du 19/10/2026 : "l'analyse ne
-- doit pas ce fait a achaque actualisation de la page il doit etre fait pas defaut et stocke en
-- base") — un snapshot par magasin pour la période par défaut (30 derniers jours), rafraîchi chaque
-- nuit par un job planifié.
CREATE TABLE "stockout_period_summary_snapshots" (
    "id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "period_days" INTEGER NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "total_ca_perdu" DOUBLE PRECISION NOT NULL,
    "total_qty_perdue" DOUBLE PRECISION NOT NULL,
    "episode_count" INTEGER NOT NULL,
    "shop_revenue_excl_tax" DOUBLE PRECISION NOT NULL,
    "department_breakdown_json" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stockout_period_summary_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stockout_period_summary_snapshots_rpos_shop_id_key" ON "stockout_period_summary_snapshots"("rpos_shop_id");
