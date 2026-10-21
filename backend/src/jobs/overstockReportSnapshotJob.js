/**
 * Job planifié : précalcule et STOCKE le rapport Surstock (OverstockReport.tsx) pour ses vues
 * chargées automatiquement au premier affichage de la page — demande explicite du 21/10/2026 :
 * "il charge trop pourqhoi ? il fait les calcule quand j'actualise ?". Le calcul est rapide isolé
 * (~0.6-1.3s mesuré) mais ralentit fortement (56 à 72s observés en prod) quand il tombe en
 * concurrence avec les jobs de synchro RPOS (stockMoveSyncJob, salesSyncJob...) qui saturent le
 * pool de connexions DB au même moment, ET que le volume de propositions/lignes à parcourir est
 * grand (~51 magasins × 90 jours) — ce job déplace ce coût hors du chemin de la requête utilisateur.
 *
 * Deux snapshots désormais précalculés :
 * - "default" : situation actuelle (sans période), seuil par défaut.
 * - "period:90d" : vue "3 derniers mois" glissants, ajoutée le 21/10/2026 car devenue le mode de
 *   chargement PAR DÉFAUT de la page (demande explicite : "il faut affiché la courbe apres une
 *   analyser qui fait par defaut sur 3mois") — sans ce second snapshot, chaque premier chargement
 *   de page retombait sur le calcul en direct, 56-72s en prod (voir insights.js pour la tolérance
 *   de correspondance appliquée à la lecture, le job tournant toutes les heures donc "3 mois à
 *   l'heure near du job" plutôt que "3 mois à la seconde près de la requête").
 *
 * Calculés pour allowedShopIds=null (périmètre ADMIN, tous les magasins) : un SUPERVISOR avec un
 * périmètre restreint filtre ce snapshot complet à la lecture (overstockReportService.js), jamais
 * un second calcul — filtrer un tableau déjà en mémoire est négligeable comparé au recalcul complet.
 *
 * Tout seuil personnalisé ou toute AUTRE période choisie par l'utilisateur continue d'appeler
 * getOverstockReport() en direct via la route — stocker toutes les combinaisons n'a pas de sens
 * (même raisonnement que stockoutPeriodSummarySnapshotJob.js pour les dates personnalisées).
 */
const prisma = require('../utils/prisma');
const { getOverstockReport, DEFAULT_MIN_WEEKS_OF_COVERAGE } = require('../services/overstockReportService');

const CACHE_KEY = `default:${DEFAULT_MIN_WEEKS_OF_COVERAGE}`;
const PERIOD_90D_CACHE_KEY = `period:90d:${DEFAULT_MIN_WEEKS_OF_COVERAGE}`;
const PERIOD_90D_DAYS = 90;

async function runOverstockReportSnapshotJob() {
  console.log('[overstockReportSnapshotJob] Précalcul démarré...');
  try {
    const report = await getOverstockReport(null, { minWeeksOfCoverage: DEFAULT_MIN_WEEKS_OF_COVERAGE });
    await prisma.overstockReportSnapshot.upsert({
      where: { cacheKey: CACHE_KEY },
      create: { cacheKey: CACHE_KEY, reportJson: JSON.stringify(report) },
      update: { reportJson: JSON.stringify(report) },
    });
    console.log(`[overstockReportSnapshotJob] Précalcul terminé (default) : ${report.articleCount ?? 0} article(s) en surstock sur ${report.shopCount ?? 0} magasin(s).`);
  } catch (err) {
    console.error('[overstockReportSnapshotJob] Échec (default) :', err.message);
  }

  try {
    const end = new Date();
    const start = new Date(end.getTime() - PERIOD_90D_DAYS * 24 * 60 * 60 * 1000);
    const periodReport = await getOverstockReport(null, {
      minWeeksOfCoverage: DEFAULT_MIN_WEEKS_OF_COVERAGE,
      start: start.toISOString(),
      end: end.toISOString(),
    });
    await prisma.overstockReportSnapshot.upsert({
      where: { cacheKey: PERIOD_90D_CACHE_KEY },
      create: { cacheKey: PERIOD_90D_CACHE_KEY, reportJson: JSON.stringify(periodReport) },
      update: { reportJson: JSON.stringify(periodReport) },
    });
    console.log(`[overstockReportSnapshotJob] Précalcul terminé (3 mois) : ${periodReport.articleCount ?? 0} article(s) en surstock sur ${periodReport.shopCount ?? 0} magasin(s).`);
  } catch (err) {
    console.error('[overstockReportSnapshotJob] Échec (3 mois) :', err.message);
  }
}

module.exports = { runOverstockReportSnapshotJob, CACHE_KEY, PERIOD_90D_CACHE_KEY, PERIOD_90D_DAYS };
