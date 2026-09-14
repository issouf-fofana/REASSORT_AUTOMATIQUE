/**
 * Job planifié : met à jour ProposalOrder.receptionStatus des commandes en cours.
 *
 * IMPORTANT — correction suite à un retour terrain : le statut RPOS de supplier_order N'EST PAS
 * un indicateur fiable de réception réelle. Une commande peut rester "en attente de livraison"
 * dans RPOS alors que la marchandise a déjà été livrée au magasin. La vraie confirmation de
 * réception viendrait de l'intégration de la facture magasin (/api/delivery/, champ "validated"),
 * MAIS les commandes de cette plateforme passent par le fournisseur central, qui ne génère jamais
 * d'enregistrement de réception dans RPOS (confirmé : 0 delivery liée au fournisseur central).
 *
 * En l'absence de confirmation fiable pour ce type de commande, le seul repère disponible est le
 * délai de réception configuré par magasin (ReassortConfig.receptionLeadTimeDays) : une commande
 * passe en "reçue (estimée)" une fois ce délai écoulé depuis la validation. Ce n'est PAS une
 * confirmation réelle et doit toujours être présenté comme tel à l'utilisateur (cf. frontend,
 * badge "estimé" jamais un badge de certitude).
 *
 * Seule exception fiable : l'annulation. Le statut RPOS 6 (annulée) reste vérifié, car une
 * commande annulée n'a par définition jamais pu être livrée.
 */
const prisma = require('../utils/prisma');
const rpos = require('../services/rposClient');
const { mapWithConcurrency } = require('../utils/concurrency');


const TERMINAL_STATUSES = new Set(['RECUE_ESTIMEE', 'ANNULEE']);

// Les commandes en attente peuvent s'accumuler (jusqu'à plusieurs centaines) et sont réparties sur
// plusieurs serveurs RPOS différents : un appel getSupplierOrderStatus séquentiel par commande
// (avant) pouvait prendre plusieurs minutes sur un cycle chargé (audit performance).
const ORDER_CONCURRENCY = 8;

async function runReceptionSync() {
  const pending = await prisma.proposalOrder.findMany({
    where: {
      rposOrderId: { not: null },
      receptionStatus: { notIn: Array.from(TERMINAL_STATUSES) },
    },
    select: {
      id: true, rposOrderId: true, receptionStatus: true, expectedReceptionDate: true,
      proposal: { select: { rposPosId: true } },
    },
  });

  console.log(`[receptionSyncJob] ${pending.length} commande(s) à vérifier...`);

  const now = new Date();
  let updated = 0;

  await mapWithConcurrency(pending, ORDER_CONCURRENCY, async (order) => {
    const posId = order.proposal.rposPosId;
    if (!posId) return;

    try {
      // Seule vérification RPOS conservée : l'annulation, seul statut réellement fiable ici.
      const rposStatus = await rpos.getSupplierOrderStatus(posId, order.rposOrderId);
      if (rposStatus === 6) {
        await prisma.proposalOrder.update({
          where: { id: order.id },
          data: { receptionStatus: 'ANNULEE', lastRposStatus: 6, lastSyncedAt: now },
        });
        await prisma.receptionEvent.create({
          data: { proposalOrderId: order.id, rposStatus: 6, receptionStatus: 'ANNULEE' },
        });
        updated += 1;
        return;
      }

      // Sinon, la seule information disponible est le délai configuré : une fois la date prévue
      // de réception dépassée, on considère la commande "reçue (estimée)" — jamais une certitude.
      if (order.expectedReceptionDate && order.expectedReceptionDate <= now) {
        await prisma.proposalOrder.update({
          where: { id: order.id },
          data: { receptionStatus: 'RECUE_ESTIMEE', actualReceptionDate: now, lastRposStatus: rposStatus, lastSyncedAt: now },
        });
        await prisma.receptionEvent.create({
          data: { proposalOrderId: order.id, rposStatus: rposStatus ?? -1, receptionStatus: 'RECUE_ESTIMEE' },
        });
        updated += 1;
      }
    } catch (err) {
      console.error(`[receptionSyncJob] Échec pour la commande ${order.rposOrderId}:`, err.message);
    }
  });

  console.log(`[receptionSyncJob] Terminé : ${updated} commande(s) mise(s) à jour.`);
}

module.exports = { runReceptionSync };
