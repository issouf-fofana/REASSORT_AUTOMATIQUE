/**
 * Validation d'une commande RPOS déjà "en préparation" (statut 1) vers "attente de livraison"
 * (statut 2) — extrait de la route POST /orders/:rposOrderId/validate (routes/reassort/shops.js)
 * le 30/10/2026 pour être réutilisé à l'identique par le nouveau workflow d'action du chatbot
 * (passer/valider une commande de rayon en conversation), sans dupliquer cette logique.
 */
const prisma = require('../utils/prisma');
const rpos = require('./rposClient');

/**
 * Revérifie le statut RPOS RÉEL juste avant d'agir (jamais une simple relecture de la base, qui
 * peut être périmée) puis valide la commande sur RPOS et met à jour la ProposalOrder locale.
 * Lève une erreur avec `.statusCode` (409 si le statut RPOS n'est plus 1) que l'appelant HTTP ou
 * le tool chatbot peut utiliser pour répondre de façon appropriée.
 */
async function validateRposOrder({ posId, rposOrderId, proposalOrder }) {
  const currentStatus = await rpos.getSupplierOrderStatus(posId, rposOrderId);
  if (currentStatus !== 1) {
    const err = new Error(`Cette commande n'est plus "en préparation" sur RPOS (statut actuel : ${currentStatus ?? 'introuvable'}) — impossible de la valider depuis ici.`);
    err.statusCode = 409;
    throw err;
  }

  await rpos.validateSupplierOrder(posId, { orderId: rposOrderId });

  if (proposalOrder) {
    await prisma.proposalOrder.update({ where: { id: proposalOrder.id }, data: { rposOrderValidated: true, lastRposStatus: 2 } });
  }

  return { success: true, message: 'Commande validée sur RPOS — elle sera prise en compte par l\'entrepôt.' };
}

module.exports = { validateRposOrder };
