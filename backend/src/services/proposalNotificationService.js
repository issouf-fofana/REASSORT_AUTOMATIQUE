/**
 * Alertes email liées aux propositions de commande (demande du 25/09/2026) : partagées entre le
 * job nocturne (nouvelle proposition) et le job de relance (proposition encore en attente avant la
 * fermeture de la fenêtre entrepôt à 13h) — même liste de destinataires, même lien vers la page de
 * validation, jamais dupliqués.
 */
const prisma = require('../utils/prisma');
const outlookMailService = require('./outlookMailService');
const { checkSupplierEligibility } = require('./proposalService');

/** Comptes à alerter pour un magasin donné : rattachement direct (DIRECTOR/DEPARTMENT_HEAD/
 * SHELF_STOCKER) + SUPERVISOR qui le couvrent. */
async function getShopRecipients(rposShopId) {
  const [directUsers, supervisors] = await Promise.all([
    prisma.user.findMany({ where: { rposShopId, isActive: true }, select: { email: true } }),
    prisma.user.findMany({
      where: { role: 'SUPERVISOR', isActive: true, supervisedShops: { some: { rposShopId } } },
      select: { email: true },
    }),
  ]);
  return [...new Set([...directUsers, ...supervisors].map((u) => u.email))];
}

function purchaseOrderLink(shop) {
  const siteUrl = process.env.FRONTEND_URL || 'https://reassort.local';
  return `${siteUrl}/purchase-order?shop=${encodeURIComponent(shop.rposShopId)}`;
}

/** Liste HTML des articles non rattachés au fournisseur central RPOS (peuvent manquer à l'envoi
 * réel de la commande). Un échec de ce contrôle (RPOS indisponible...) ne doit jamais empêcher
 * l'envoi du mail lui-même : la liste est alors omise plutôt que de bloquer toute la notification. */
async function buildSupplierWarningHtml(shop, lines) {
  try {
    const ineligible = await checkSupplierEligibility(shop.rposPosId, shop.rposShopId, lines);
    if (!ineligible.length) return '';
    const items = ineligible
      .map((l) => `<li>${l.label || l.ean} (${l.ean}) — fournisseur actuel : ${l.currentSuppliers}</li>`)
      .join('');
    return `
      <p style="color:#b45309;"><strong>⚠️ ${ineligible.length} article(s) non rattaché(s) au fournisseur central</strong> —
      risque qu'ils manquent à l'envoi réel de la commande :</p>
      <ul>${items}</ul>
    `;
  } catch (err) {
    console.error(`[proposalNotificationService] Contrôle fournisseur échoué pour ${shop.reference}:`, err.message);
    return '';
  }
}

/** Alerte de nouvelle proposition générée (job nocturne) — jamais sur une génération manuelle. */
async function notifyShopUsersOfNewProposal(shop, stats, proposal) {
  const recipients = await getShopRecipients(shop.rposShopId);
  if (!recipients.length) return;

  const link = purchaseOrderLink(shop);
  const supplierWarningHtml = await buildSupplierWarningHtml(shop, proposal.lines);

  await outlookMailService.sendMail({
    to: recipients,
    subject: `Réassort Automatique — nouvelle proposition pour ${shop.reference} (${shop.name})`,
    htmlBody: `
      <p>Une nouvelle proposition de commande vient d'être générée pour le magasin <strong>${shop.reference} — ${shop.name}</strong>.</p>
      <p><strong>${stats.proposalsGenerated}</strong> article(s) proposé(s).</p>
      ${supplierWarningHtml}
      <p>Merci de vous connecter pour vérifier et valider cette commande :</p>
      <p><a href="${link}">${link}</a></p>
    `,
  });
}

/** Relance pour une proposition GENERATED encore en attente (job de 10h, demande du 25/09/2026 :
 * "les alertes peuvent être entre 9h et 11h", l'entrepôt ne reçoit plus les commandes après 13h).
 * Gravité volontairement plus marquée que le mail initial (couleur rouge, mention explicite du
 * délai) pour se distinguer visuellement d'une simple information. */
async function notifyShopUsersOfPendingProposal(shop, proposal) {
  const recipients = await getShopRecipients(shop.rposShopId);
  if (!recipients.length) return;

  const link = purchaseOrderLink(shop);

  await outlookMailService.sendMail({
    to: recipients,
    subject: `⚠️ Rappel urgent — proposition non validée pour ${shop.reference} (${shop.name})`,
    htmlBody: `
      <p style="color:#c0392b;"><strong>La proposition de commande du magasin ${shop.reference} — ${shop.name} n'est toujours pas validée.</strong></p>
      <p><strong>${proposal.lines.length}</strong> article(s) en attente de vérification.</p>
      <p style="color:#c0392b;">L'entrepôt ne reçoit plus les commandes après <strong>13h</strong> — au-delà, cette commande sera traitée le lendemain.</p>
      <p>Merci de vous connecter dès que possible pour vérifier et valider cette commande :</p>
      <p><a href="${link}">${link}</a></p>
    `,
  });
}

module.exports = { getShopRecipients, purchaseOrderLink, buildSupplierWarningHtml, notifyShopUsersOfNewProposal, notifyShopUsersOfPendingProposal };
