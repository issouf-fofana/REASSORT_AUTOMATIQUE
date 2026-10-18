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

// Relevé de 8 à 25 le 18/10/2026 (bug signalé : "CA perdu estimé" à 0 CFA sur la quasi-totalité du
// réseau — 20310 épisodes ouverts au total en prod, 8 en parallèle ne finissait jamais un passage
// complet avant le déclenchement suivant, verrouillé par stockoutLossRecalcLock). 25 reste
// raisonnable pour la base (chaque calcul fait 2 requêtes SQL), mais couvre le réseau nettement
// plus vite — combiné à la priorisation ci-dessous.
const RECALC_CONCURRENCY = 25;

async function runStockoutLossRecalcJob() {
  console.log('[stockoutLossRecalcJob] Recalcul démarré...');

  // Priorise les épisodes JAMAIS calculés (caPerdueEstime encore null) avant ceux déjà à jour —
  // demande explicite du 18/10/2026 : "je veux mettre a jour tout un coup et le job doit faire a
  // tout moment". Avec 20000+ épisodes ouverts sur tout le réseau, un passage ne couvre pas
  // forcément tout en une heure (fréquence du cron) : sans cet ordre, les magasins traités en
  // dernier (toujours les mêmes, triés par id) restaient indéfiniment à 0 CFA pendant que les
  // premiers étaient recalculés en boucle pour rien (valeur déjà correcte).
  const openEpisodes = await prisma.stockoutEpisode.findMany({
    where: { status: 'EN_COURS' },
    select: { id: true, rposShopId: true, ean: true, startedAt: true, caPerdueEstime: true },
    orderBy: [{ caPerdueEstime: { sort: 'asc', nulls: 'first' } }],
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
