/**
 * Job planifié : relance par email les magasins ayant encore une proposition de commande en
 * attente (status GENERATED) au moment où le job tourne (demande du 25/09/2026, réglé par défaut
 * à 10h — l'entrepôt ne reçoit plus les commandes après 13h, donc une proposition toujours en
 * attente à ce moment-là risque de partir trop tard). Relance TOUTES les propositions encore en
 * attente, peu importe leur ancienneté — pas seulement celles générées la nuit même.
 */
const prisma = require('../utils/prisma');
const { mapWithConcurrency } = require('../utils/concurrency');
const { notifyShopUsersOfPendingProposal } = require('../services/proposalNotificationService');

const SHOP_CONCURRENCY = 5; // pas d'appel RPOS ici (juste lecture DB + envoi mail), concurrence plus large que le job nocturne

async function runProposalReminder() {
  const pending = await prisma.proposal.findMany({
    where: { status: 'GENERATED' },
    include: { lines: true },
  });

  if (!pending.length) {
    console.log('[proposalReminderJob] Aucune proposition en attente, rien à relancer.');
    return { reminded: 0, failed: 0 };
  }

  const shopIds = [...new Set(pending.map((p) => p.rposShopId))];
  const shops = await prisma.shop.findMany({
    where: { rposShopId: { in: shopIds } },
    select: { rposShopId: true, reference: true, name: true, rposPosId: true },
  });
  const shopById = new Map(shops.map((s) => [s.rposShopId, s]));

  console.log(`[proposalReminderJob] ${pending.length} proposition(s) en attente à relancer...`);

  let reminded = 0;
  let failed = 0;

  await mapWithConcurrency(pending, SHOP_CONCURRENCY, async (proposal) => {
    const shop = shopById.get(proposal.rposShopId);
    if (!shop) return; // magasin désactivé/retiré depuis, rien à relancer
    try {
      await notifyShopUsersOfPendingProposal(shop, proposal);
      reminded += 1;
    } catch (err) {
      failed += 1;
      console.error(`[proposalReminderJob] Relance échouée pour ${shop.reference}:`, err.message);
    }
  });

  console.log(`[proposalReminderJob] Terminé : ${reminded} relance(s) envoyée(s), ${failed} échec(s).`);
  return { reminded, failed };
}

module.exports = { runProposalReminder };
