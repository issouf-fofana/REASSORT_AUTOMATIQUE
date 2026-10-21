-- Précalcul du rapport Surstock (demande explicite du 21/10/2026 : "il charge trop pourqhoi ? il
-- fait les calcule quand j'actualise ?") — un seul snapshot pour la vue par défaut (situation
-- actuelle, seuil par défaut), rafraîchi par un job planifié.
CREATE TABLE "overstock_report_snapshots" (
    "id" TEXT NOT NULL,
    "cache_key" TEXT NOT NULL,
    "report_json" TEXT NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "overstock_report_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "overstock_report_snapshots_cache_key_key" ON "overstock_report_snapshots"("cache_key");
