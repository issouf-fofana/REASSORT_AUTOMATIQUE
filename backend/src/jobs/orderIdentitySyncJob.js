/**
 * Job planifié : précalcule qui a créé/validé chaque commande fournisseur côté RPOS, et sa date de
 * validation réelle (ProposalOrder.rposCreatedBy/rposValidatedBy/rposValidationDate) — ajouté le
 * 18/10/2026 (bug de performance signalé : la fiche détail d'un épisode de rupture appelait RPOS en
 * DIRECT à chaque chargement, via getSupplierOrders, une liste PAGINÉE de 200 commandes, juste pour
 * retrouver une seule commande par sa référence — ralentissait/bloquait l'affichage, et laissait la
 * page sans aucune donnée si RPOS était injoignable à cet instant précis. "je veux les info soit
 * stocke... par appel api a tout moments si api n'est pas dispo je dois pouvoir fonctionné").
 *
 * Contrairement à receptionSyncJob.js (qui revérifie en boucle tant que receptionStatus n'est pas
 * terminal), cette identité ne change JAMAIS une fois la commande créée côté RPOS : une seule
 * synchronisation par commande suffit (rposValidationDate encore null = jamais synchronisée), même
 * après un passage en statut terminal (RECUE_ESTIMEE/ANNULEE) — receptionSyncJob.js, lui, arrête de
 * revérifier ces commandes, donc cette identité ne serait jamais remplie sinon.
 */
const prisma = require('../utils/prisma');
const rpos = require('../services/rposClient');
const { mapWithConcurrency } = require('../utils/concurrency');

const ORDER_CONCURRENCY = 8;
// Ne retente pas indéfiniment une commande dont RPOS n'a jamais renvoyé l'identité (ex: commande
// très ancienne purgée côté RPOS) — au-delà de ce nombre de jours sans succès, considérée perdue.
const MAX_AGE_DAYS = 30;

async function runOrderIdentitySync() {
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
  const pending = await prisma.proposalOrder.findMany({
    where: { rposOrderId: { not: null }, rposValidationDate: null, createdAt: { gte: cutoff } },
    select: { id: true, rposOrderId: true, proposal: { select: { rposPosId: true } } },
  });

  console.log(`[orderIdentitySyncJob] ${pending.length} commande(s) sans identité RPOS à synchroniser...`);

  let updated = 0;
  await mapWithConcurrency(pending, ORDER_CONCURRENCY, async (order) => {
    const posId = order.proposal.rposPosId;
    if (!posId) return;
    try {
      const detail = await rpos.getSupplierOrderDetail(posId, order.rposOrderId);
      if (!detail || !detail.validationDate) return; // pas encore validée côté RPOS, retentera au prochain passage
      await prisma.proposalOrder.update({
        where: { id: order.id },
        data: {
          rposCreatedBy: detail.createdBy,
          rposValidatedBy: detail.validatedBy,
          rposValidationDate: new Date(detail.validationDate),
        },
      });
      updated += 1;
    } catch (err) {
      console.error(`[orderIdentitySyncJob] Échec pour la commande ${order.id} :`, err.message);
    }
  });

  console.log(`[orderIdentitySyncJob] Terminé : ${updated} commande(s) mise(s) à jour.`);
  return { updated, total: pending.length };
}

module.exports = { runOrderIdentitySync };
