/**
 * Job planifié : génère chaque nuit la proposition de réassort de tous les magasins actifs,
 * pour qu'elle soit déjà prête quand le responsable magasin se connecte le matin (phase pilote,
 * cf. readme section 9-10).
 */
const { PrismaClient } = require('@prisma/client');
const { generateAndSaveProposal } = require('../services/proposalService');
const { mapWithConcurrency } = require('../utils/concurrency');
const { runAiForecast } = require('../services/aiForecastService');
const { MIN_DAYS_FOR_SMOOTHING } = require('../services/forecastService');

const prisma = new PrismaClient();

// L'analyse IA n'est lancée automatiquement QUE sur ce job nocturne (une fois par jour par
// magasin), jamais sur une génération manuelle/forcée en journée : chaque analyse consomme un
// appel à une clé API IA payante/à quota, et automatiser ça sur toute génération sur 52 magasins
// rendrait le volume d'appels imprévisible. Le même seuil de 14 jours que le lissage exponentiel
// (forecastService.js) sert de garde-fou : sous ce seuil, l'historique est trop court pour qu'une
// analyse IA apporte quoi que ce soit de plus fiable qu'un calcul classique.
const MIN_DAYS_FOR_AI_FORECAST = MIN_DAYS_FOR_SMOOTHING;

// Chaque magasin fait déjà jusqu'à ~1000 appels RPOS en interne (CONCURRENCY=10 par lot d'articles,
// cf. proposalService.js) : traiter tous les magasins en série (comme avant) pouvait prendre
// plusieurs heures cumulées sur 52 magasins (audit performance). 3 magasins en parallèle réduit ce
// temps total sans multiplier par un facteur incontrôlé la charge simultanée sur RPOS.
const SHOP_CONCURRENCY = 3;

async function runNightlyProposalGeneration() {
  const shops = await prisma.user.findMany({
    where: { role: 'STORE', isActive: true, rposShopId: { not: null }, rposPosId: { not: null } },
    distinct: ['rposShopId'],
    select: { rposShopId: true, rposShopReference: true, rposShopName: true, rposPosId: true },
  });

  console.log(`[nightlyProposalJob] Génération pour ${shops.length} magasin(s) (${SHOP_CONCURRENCY} en parallèle)...`);

  await mapWithConcurrency(shops, SHOP_CONCURRENCY, async (shop) => {
    try {
      const { proposal, stats } = await generateAndSaveProposal({
        posId: shop.rposPosId,
        shopId: shop.rposShopId,
        shopReference: shop.rposShopReference,
        shopName: shop.rposShopName,
      });

      console.log(`[nightlyProposalJob] ${shop.rposShopReference} (${shop.rposShopName}): ${stats.proposalsGenerated} proposition(s)`);

      const periodDays = (new Date(stats.periodEnd) - new Date(stats.periodStart)) / (24 * 60 * 60 * 1000);
      if (periodDays >= MIN_DAYS_FOR_AI_FORECAST && stats.proposalsGenerated > 0) {
        try {
          await runAiForecast(proposal.id, 'nightlyProposalJob');
          console.log(`[nightlyProposalJob] ${shop.rposShopReference} : analyse IA automatique terminée.`);
        } catch (aiError) {
          // Ne fait jamais échouer la génération de la proposition elle-même (déjà réussie et
          // sauvegardée à ce stade) : l'IA reste une couche optionnelle par-dessus le calcul
          // classique, qui doit continuer à fonctionner même sans clé API IA configurée.
          console.error(`[nightlyProposalJob] Analyse IA automatique échouée pour ${shop.rposShopReference}:`, aiError.message);
        }
      }
    } catch (error) {
      console.error(`[nightlyProposalJob] Échec pour ${shop.rposShopReference}:`, error.message);
    }
  });

  console.log('[nightlyProposalJob] Terminé.');
}

module.exports = { runNightlyProposalGeneration };
