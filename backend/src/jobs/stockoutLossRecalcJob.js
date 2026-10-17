/**
 * Job planifié : recalcule et STOCKE qtyPerdueEstimee/caPerdueEstime pour tous les épisodes de
 * rupture EN_COURS (bug de performance trouvé le 17/10/2026 : avec plusieurs centaines d'épisodes
 * ouverts sur un magasin, recalculer cette perte EN TEMPS RÉEL à chaque chargement de page
 * — getDashboardSummary/getDashboardSummaryByField/getEpisodeDetail — fait exploser le temps de
 * réponse (~3s par endpoint, 4 endpoints en parallèle au chargement de /stockouts). Demande
 * explicite de l'utilisateur : "les calcule de perte et autre doit etre fait au prealable... comme
 * la vue de proposition de commande" — même principe que la génération de proposition (calcul
 * lourd en tâche de fond, lecture instantanée côté page).
 *
 * Après ce job, toutes les fonctions de lecture (getDashboardSummary, getDashboardSummaryByField,
 * getEpisodeDetail) lisent UNIQUEMENT episode.qtyPerdueEstimee/caPerdueEstime déjà stockés, qu'ils
 * soient EN_COURS ou RESOLUE — plus aucun appel à estimateLoss() à la lecture.
 */
const prisma = require('../utils/prisma');
const { estimateLoss } = require('../services/stockoutEpisodeService');
const { mapWithConcurrency } = require('../utils/concurrency');

const RECALC_CONCURRENCY = 8;

async function runStockoutLossRecalcJob() {
  console.log('[stockoutLossRecalcJob] Recalcul démarré...');

  const openEpisodes = await prisma.stockoutEpisode.findMany({
    where: { status: 'EN_COURS' },
    select: { id: true, rposShopId: true, ean: true, startedAt: true },
  });

  const now = new Date();
  let updated = 0;
  await mapWithConcurrency(openEpisodes, RECALC_CONCURRENCY, async (episode) => {
    const { qtyPerdue, caPerdue } = await estimateLoss(episode.rposShopId, episode.ean, episode.startedAt, now);
    await prisma.stockoutEpisode.update({
      where: { id: episode.id },
      data: { qtyPerdueEstimee: qtyPerdue, caPerdueEstime: caPerdue },
    });
    updated += 1;
  });

  console.log(`[stockoutLossRecalcJob] Recalcul terminé : ${updated}/${openEpisodes.length} épisode(s) EN_COURS mis à jour.`);
}

module.exports = { runStockoutLossRecalcJob };
