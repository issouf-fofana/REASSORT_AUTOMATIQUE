/**
 * Job planifié : précalcule et STOCKE le rapport Surstock (OverstockReport.tsx) pour sa vue PAR
 * DÉFAUT (situation actuelle, seuil DEFAULT_MIN_WEEKS_OF_COVERAGE) — demande explicite du
 * 21/10/2026 : "il charge trop pourqhoi ? il fait les calcule quand j'actualise ?". Le calcul est
 * rapide isolé (~0.6s mesuré) mais ralentit fortement (jusqu'à 14s observés) quand il tombe en
 * concurrence avec les jobs de synchro RPOS (stockMoveSyncJob, stockoutProductCacheRefreshJob...)
 * qui saturent le pool de connexions DB au même moment — ce job déplace ce coût hors du chemin de
 * la requête utilisateur.
 *
 * Calculé pour allowedShopIds=null (périmètre ADMIN, tous les magasins) : un SUPERVISOR avec un
 * périmètre restreint filtre ce snapshot complet à la lecture (overstockReportService.js), jamais
 * un second calcul — filtrer un tableau déjà en mémoire est négligeable comparé au recalcul complet.
 *
 * Ne couvre QUE la vue par défaut, un seul snapshot (OverstockReportSnapshot, cacheKey fixe). Tout
 * seuil personnalisé ou toute période choisie par l'utilisateur continue d'appeler
 * getOverstockReport() en direct via la route — stocker toutes les combinaisons n'a pas de sens
 * (même raisonnement que stockoutPeriodSummarySnapshotJob.js pour les dates personnalisées).
 */
const prisma = require('../utils/prisma');
const { getOverstockReport, DEFAULT_MIN_WEEKS_OF_COVERAGE } = require('../services/overstockReportService');

const CACHE_KEY = `default:${DEFAULT_MIN_WEEKS_OF_COVERAGE}`;

async function runOverstockReportSnapshotJob() {
  console.log('[overstockReportSnapshotJob] Précalcul démarré...');
  try {
    const report = await getOverstockReport(null, { minWeeksOfCoverage: DEFAULT_MIN_WEEKS_OF_COVERAGE });
    await prisma.overstockReportSnapshot.upsert({
      where: { cacheKey: CACHE_KEY },
      create: { cacheKey: CACHE_KEY, reportJson: JSON.stringify(report) },
      update: { reportJson: JSON.stringify(report) },
    });
    console.log(`[overstockReportSnapshotJob] Précalcul terminé : ${report.articleCount ?? 0} article(s) en surstock sur ${report.shopCount ?? 0} magasin(s).`);
  } catch (err) {
    console.error('[overstockReportSnapshotJob] Échec :', err.message);
  }
}

module.exports = { runOverstockReportSnapshotJob, CACHE_KEY };
