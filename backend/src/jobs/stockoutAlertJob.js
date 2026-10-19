/**
 * Job planifié : alerte par email chaque magasin ayant des ruptures de stock EN_COURS (demande
 * explicite du 18/10/2026 : "je veux quil ai une partie la possibilité de faire un mail auto au
 * magasin sil ya des article qui son en rupture... il doit etre alecter pour ca aussi... meme si ya
 * une propostion de commande") — contrairement aux alertes de proposition (proposalNotificationService),
 * celle-ci ne s'arrête jamais à "une commande existe" : une rupture reste une rupture tant que
 * l'article n'est pas revenu en stock, le magasin doit le savoir même si une commande est déjà en
 * route.
 *
 * Un seul envoi par magasin par passage (jamais un email par article) — même principe que les
 * autres jobs d'alerte du module Ruptures.
 */
const prisma = require('../utils/prisma');
const { mapWithConcurrency } = require('../utils/concurrency');
const { getOpenEpisodes } = require('../services/stockoutEpisodeService');
const { notifyShopOfOpenStockouts, notifyAdminsOfStockoutSummary } = require('../services/stockoutNotificationService');

const SHOP_CONCURRENCY = 5; // pas d'appel RPOS ici (getOpenEpisodes lit uniquement la DB locale), concurrence large

async function runStockoutAlertJob() {
  console.log('[stockoutAlertJob] Alerte des ruptures en cours démarrée...');

  const shops = await prisma.shop.findMany({ select: { rposShopId: true, rposPosId: true, reference: true, name: true } });

  let alerted = 0;
  let skipped = 0;
  // Résumé par magasin accumulé au fil du job (demande explicite du 19/10/2026 : "il doit recevoir
  // un seul [mail] pour synthese comme pour les commande... c'est le mag qui recoit un mail pour
  // lui et l'admin un mail global pour tout") — un seul récap admin en fin de job plutôt qu'une
  // copie de chaque email magasin (même principe que nightlyProposalJob.js).
  const summaries = [];

  await mapWithConcurrency(shops, SHOP_CONCURRENCY, async (shop) => {
    const episodes = await getOpenEpisodes(shop.rposShopId);
    if (!episodes.length) { skipped += 1; return; }
    const { sent } = await notifyShopOfOpenStockouts(shop, episodes);
    if (sent) alerted += 1; else skipped += 1;
    summaries.push({
      shop: { reference: shop.reference, name: shop.name },
      episodeCount: episodes.length,
      withoutOrderCount: episodes.filter((e) => !e.hasOrder).length,
    });
  });

  try {
    await notifyAdminsOfStockoutSummary(summaries);
  } catch (err) {
    console.error('[stockoutAlertJob] Échec de l\'envoi du récap admin :', err.message);
  }

  console.log(`[stockoutAlertJob] Terminé : ${alerted} magasin(s) alerté(s), ${skipped} sans rupture ou sans destinataire.`);
  return { alerted, skipped };
}

module.exports = { runStockoutAlertJob };
