-- Précalcul journalier du CA perdu par (magasin, rayon) — demande explicite du 21/10/2026 : "je
-- veux les valeur de l'analyse... appliqué au filtre" + "le chargement auto avec calcul deja
-- prefait en base". Une ligne par (magasin, rayon, jour) permet de sommer instantanément
-- n'importe quelle plage de dates côté lecture, sans jamais recalculer à la volée.
CREATE TABLE "stockout_daily_loss_by_department" (
    "id" TEXT NOT NULL,
    "rpos_shop_id" TEXT NOT NULL,
    "department" TEXT NOT NULL DEFAULT '',
    "day" TIMESTAMP(3) NOT NULL,
    "ca_perdue" DOUBLE PRECISION NOT NULL,
    "qty_perdue" DOUBLE PRECISION NOT NULL,
    "episode_count" INTEGER NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stockout_daily_loss_by_department_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stockout_daily_loss_by_department_rposShopId_department_day_key" ON "stockout_daily_loss_by_department"("rpos_shop_id", "department", "day");

CREATE INDEX "stockout_daily_loss_by_department_rposShopId_day_idx" ON "stockout_daily_loss_by_department"("rpos_shop_id", "day");
