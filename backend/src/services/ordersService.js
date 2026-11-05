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
// onStatus optionnel (demande du 05/11/2026 : le chatbot restait visuellement figé pendant toute
// la validation, contrairement à PREPARE qui a déjà sa propre progression) — jamais requis, pour
// ne rien changer pour les appelants existants (route API classique de la page Proposition de
// commande, qui n'a pas besoin de cette progression étape par étape).
async function validateRposOrder({ posId, rposOrderId, proposalOrder, onStatus }) {
  if (onStatus) onStatus('Vérification du statut de la commande sur RPOS...');
  const currentStatus = await rpos.getSupplierOrderStatus(posId, rposOrderId);
  if (currentStatus !== 1) {
    const err = new Error(`Cette commande n'est plus "en préparation" sur RPOS (statut actuel : ${currentStatus ?? 'introuvable'}) — impossible de la valider depuis ici.`);
    err.statusCode = 409;
    throw err;
  }

  if (onStatus) onStatus('Validation de la commande auprès de RPOS...');
  await rpos.validateSupplierOrder(posId, { orderId: rposOrderId });

  if (proposalOrder) {
    if (onStatus) onStatus('Mise à jour locale de la commande...');
    await prisma.proposalOrder.update({ where: { id: proposalOrder.id }, data: { rposOrderValidated: true, lastRposStatus: 2 } });
  }

  return { success: true, message: 'Commande validée sur RPOS — elle sera prise en compte par l\'entrepôt.' };
}

module.exports = { validateRposOrder };
