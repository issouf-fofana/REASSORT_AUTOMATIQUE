/**
 * Job planifié : précalcule et STOCKE "Analyse des pertes sur une période" (StockoutPeriodAnalysis.tsx)
 * pour sa période PAR DÉFAUT (30 derniers jours glissants) — demande explicite du 19/10/2026 :
 * "l'analyse ne doit pas ce fait a achaque actualisation de la page il doit etre fait pas defaut et
 * stocke en base pour quil soit affiché". Avant ce job, getPeriodLossSummary() recalculait en direct
 * à chaque chargement de page (estimateLoss() par épisode EN_COURS chevauchant la période), d'où le
 * "Calcul en cours..." systématique vu dans l'UI.
 *
 * Ne couvre QUE la période par défaut, un seul snapshot par magasin (StockoutPeriodSummarySnapshot,
 * contrainte unique sur rposShopId). Toute période PERSONNALISÉE choisie par l'utilisateur (demande
 * confirmée explicitement : "si je met 1an il doit me donner si je met 1 jour il dois affiché
 * aussi") continue d'appeler getPeriodLossSummary() en direct via la route — stocker toutes les
 * combinaisons de dates possibles n'a pas de sens.
 */
const prisma = require('../utils/prisma');
const { getPeriodLossSummary } = require('../services/stockoutEpisodeService');
const { mapWithConcurrency } = require('../utils/concurrency');

const DEFAULT_PERIOD_DAYS = 30;
const SHOP_CONCURRENCY = 5; // une seule page le lit à la fois en pratique, même concurrence mesurée que stockoutAlertJob pour un calcul par magasin qui reste local (pas d'appel RPOS)

async function runStockoutPeriodSummarySnapshotJob() {
  console.log('[stockoutPeriodSummarySnapshotJob] Précalcul démarré...');

  const shops = await prisma.shop.findMany({ select: { rposShopId: true } });
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - DEFAULT_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  let updated = 0;
  await mapWithConcurrency(shops, SHOP_CONCURRENCY, async (shop) => {
    try {
      const summary = await getPeriodLossSummary(shop.rposShopId, { startDate: periodStart, endDate: periodEnd });
      await prisma.stockoutPeriodSummarySnapshot.upsert({
        where: { rposShopId: shop.rposShopId },
        create: {
          rposShopId: shop.rposShopId,
          periodDays: DEFAULT_PERIOD_DAYS,
          periodEnd,
          totalCaPerdu: summary.totalCaPerdu,
          totalQtyPerdue: summary.totalQtyPerdue,
          episodeCount: summary.episodeCount,
          shopRevenueExclTax: summary.shopRevenueExclTax,
          departmentBreakdownJson: JSON.stringify(summary.departmentBreakdown),
        },
        update: {
          periodDays: DEFAULT_PERIOD_DAYS,
          periodEnd,
          totalCaPerdu: summary.totalCaPerdu,
          totalQtyPerdue: summary.totalQtyPerdue,
          episodeCount: summary.episodeCount,
          shopRevenueExclTax: summary.shopRevenueExclTax,
          departmentBreakdownJson: JSON.stringify(summary.departmentBreakdown),
        },
      });
      updated += 1;
    } catch (err) {
      console.error(`[stockoutPeriodSummarySnapshotJob] Échec pour le magasin ${shop.rposShopId} :`, err.message);
    }
  });

  console.log(`[stockoutPeriodSummarySnapshotJob] Précalcul terminé : ${updated}/${shops.length} magasin(s) mis à jour.`);
}

module.exports = { runStockoutPeriodSummarySnapshotJob, DEFAULT_PERIOD_DAYS };
