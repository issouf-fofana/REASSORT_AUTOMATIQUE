/**
 * Job planifié : recalcule et STOCKE hasOrder/reactionStatus/deliveryStatus/orderCreatedAt pour
 * tous les épisodes de rupture EN_COURS — demande explicite du 20/10/2026 : "il ne calcule ps a
 * meme temps et il doit avoir un syste de calcul deja fais en base... quand un user viens il clique
 * juste pour voir sans charger et fait les calcule le but est d'optimisé".
 *
 * Même principe déjà en place pour qtyPerdueEstimee/caPerdueEstime (stockoutLossRecalcJob.js) :
 * avant ce job, getOpenEpisodes() recalculait ce statut EN DIRECT à chaque chargement de la page
 * Ruptures (matching commande + mouvement d'arrivage par article, en mémoire pour tout le magasin).
 * computeAndPersistOpenEpisodeStatuses() (stockoutEpisodeService.js) fait ce calcul ET l'écrit en
 * base ; getOpenEpisodes() ne fait plus ensuite QUE lire ces colonnes déjà calculées.
 *
 * Fréquent (toutes les 5 minutes par défaut) car ce statut peut changer à tout moment (une commande
 * peut être validée n'importe quand) — complété par des hooks ciblés déclenchés immédiatement sur
 * les événements connus (validation de commande, détection d'arrivage via stockMoveSyncJob.js) pour
 * ne pas dépendre uniquement de ce cycle pour rester à jour.
 */
const prisma = require('../utils/prisma');
const { computeAndPersistOpenEpisodeStatuses } = require('../services/stockoutEpisodeService');
const { mapWithConcurrency } = require('../utils/concurrency');

// Un magasin à la fois en interne (computeAndPersistOpenEpisodeStatuses fait déjà plusieurs
// requêtes groupées par magasin) ; concurrence ENTRE magasins, purement local (pas d'appel RPOS).
const SHOP_CONCURRENCY = 5;

async function runStockoutStatusRecalcJob() {
  console.log('[stockoutStatusRecalcJob] Recalcul démarré...');

  const shopIds = await prisma.stockoutEpisode.findMany({
    where: { status: 'EN_COURS' },
    select: { rposShopId: true },
    distinct: ['rposShopId'],
  });

  let totalUpdated = 0;
  await mapWithConcurrency(shopIds, SHOP_CONCURRENCY, async ({ rposShopId }) => {
    try {
      const updated = await computeAndPersistOpenEpisodeStatuses(rposShopId);
      totalUpdated += updated.length;
    } catch (err) {
      console.error(`[stockoutStatusRecalcJob] Échec pour le magasin ${rposShopId}:`, err.message);
    }
  });

  console.log(`[stockoutStatusRecalcJob] Terminé : ${totalUpdated} épisode(s) mis à jour sur ${shopIds.length} magasin(s).`);
}

module.exports = { runStockoutStatusRecalcJob };
