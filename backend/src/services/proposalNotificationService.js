/**
 * Alertes email liées aux propositions de commande (demande du 25/09/2026) : partagées entre le
 * job nocturne (nouvelle proposition) et le job de relance (proposition encore en attente avant la
 * fermeture de la fenêtre entrepôt à 13h) — même liste de destinataires, même lien vers la page de
 * validation, jamais dupliqués.
 */
const prisma = require('../utils/prisma');
const outlookMailService = require('./outlookMailService');
const rpos = require('./rposClient');
const { checkSupplierEligibility } = require('./proposalService');

/** Comptes à alerter pour un magasin donné : rattachement direct (DIRECTOR/DEPARTMENT_HEAD/
 * SHELF_STOCKER) + SUPERVISOR qui le couvrent + TOUJOURS les ADMIN en copie (demande du 25/09/2026)
 * — garantit une visibilité globale et évite qu'une alerte parte dans le vide pour un magasin sans
 * aucun compte encore rattaché (repli implicite : la liste n'est alors jamais vide). Renvoie les
 * emails seuls (compatibilité avec les appelants existants qui n'ont besoin que de ça, ex: la popup
 * "retirer un destinataire") — cf. getShopRecipientUsers ci-dessous pour la version avec le nom,
 * nécessaire à la salutation personnalisée ("Bonjour <nom>", demande du 25/09/2026 : LE NOM VIENT
 * TOUJOURS du compte réel de chaque destinataire — AD ou local, jamais un nom en dur). */
async function getShopRecipientUsers(rposShopId) {
  const [directUsers, supervisors, admins] = await Promise.all([
    prisma.user.findMany({ where: { rposShopId, isActive: true }, select: { email: true, name: true } }),
    prisma.user.findMany({
      where: { role: 'SUPERVISOR', isActive: true, supervisedShops: { some: { rposShopId } } },
      select: { email: true, name: true },
    }),
    prisma.user.findMany({ where: { role: 'ADMIN', isActive: true }, select: { email: true, name: true } }),
  ]);
  const byEmail = new Map();
  for (const u of [...directUsers, ...supervisors, ...admins]) byEmail.set(u.email, u);
  return [...byEmail.values()];
}

async function getShopRecipients(rposShopId) {
  return (await getShopRecipientUsers(rposShopId)).map((u) => u.email);
}

/** Envoie le même email à chaque destinataire INDIVIDUELLEMENT (jamais un seul envoi groupé,
 * demande du 25/09/2026 : "Bonjour <nom>" doit être le vrai nom de CE destinataire précis, pas
 * une liste anonyme en copie) — `buildMailForUser(user)` construit le corps personnalisé pour
 * chaque utilisateur, appelé une fois par destinataire. Un échec d'envoi à UN destinataire ne doit
 * jamais empêcher les autres de recevoir le leur : capturé et loggé par destinataire, jamais
 * propagé pour interrompre la boucle. */
async function sendMailToEachRecipient(users, buildMailForUser) {
  for (const user of users) {
    try {
      const { subject, htmlBody, attachments } = await buildMailForUser(user);
      await outlookMailService.sendMail({ to: user.email, subject, htmlBody, attachments });
    } catch (err) {
      console.error(`[proposalNotificationService] Envoi échoué pour ${user.email}:`, err.message);
    }
  }
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

/** Alerte de nouvelle proposition générée (job nocturne) — jamais sur une génération manuelle.
 * Un email individuel par destinataire (demande du 25/09/2026), avec son vrai nom en salutation. */
async function notifyShopUsersOfNewProposal(shop, stats, proposal) {
  const users = await getShopRecipientUsers(shop.rposShopId);
  if (!users.length) return;

  const link = purchaseOrderLink(shop);
  const supplierWarningHtml = await buildSupplierWarningHtml(shop, proposal.lines);

  await sendMailToEachRecipient(users, async (user) => ({
    subject: `Réassort Automatique — nouvelle proposition pour ${shop.reference} (${shop.name})`,
    htmlBody: `
      <p>Bonjour ${user.name},</p>
      <p>Une nouvelle proposition de commande vient d'être générée pour le magasin <strong>${shop.reference} — ${shop.name}</strong>.</p>
      <p><strong>${stats.proposalsGenerated}</strong> article(s) proposé(s).</p>
      ${supplierWarningHtml}
      <p>Merci de vous connecter pour vérifier et valider cette commande :</p>
      <p><a href="${link}">${link}</a></p>
    `,
  }));
}

/** Relance pour une proposition GENERATED encore en attente (job de 10h, demande du 25/09/2026 :
 * "les alertes peuvent être entre 9h et 11h", l'entrepôt ne reçoit plus les commandes après 13h).
 * Gravité volontairement plus marquée que le mail initial (couleur rouge, mention explicite du
 * délai) pour se distinguer visuellement d'une simple information. Un email individuel par
 * destinataire (demande du 25/09/2026), avec son vrai nom en salutation.
 * `overrideRecipientEmails` (optionnel) : liste d'emails choisie à la main (popup de confirmation
 * avant l'envoi manuel, demande du 25/09/2026 — "les enlever ou pas") — filtre la liste calculée
 * automatiquement, jamais utilisé par les jobs planifiés eux-mêmes. */
async function notifyShopUsersOfPendingProposal(shop, proposal, overrideRecipientEmails) {
  let users = await getShopRecipientUsers(shop.rposShopId);
  if (overrideRecipientEmails) users = users.filter((u) => overrideRecipientEmails.includes(u.email));
  if (!users.length) return;

  const link = purchaseOrderLink(shop);

  await sendMailToEachRecipient(users, async (user) => ({
    subject: `⚠️ Rappel urgent — proposition non validée pour ${shop.reference} (${shop.name})`,
    htmlBody: `
      <p>Bonjour ${user.name},</p>
      <p style="color:#c0392b;"><strong>La proposition de commande du magasin ${shop.reference} — ${shop.name} n'est toujours pas validée.</strong></p>
      <p><strong>${proposal.lines.length}</strong> article(s) en attente de vérification.</p>
      <p style="color:#c0392b;">L'entrepôt ne reçoit plus les commandes après <strong>13h</strong> — au-delà, cette commande sera traitée le lendemain.</p>
      <p>Merci de vous connecter dès que possible pour vérifier et valider cette commande :</p>
      <p><a href="${link}">${link}</a></p>
    `,
  }));
}

/** Une ligne <li> par commande RPOS créée (une par rayon, readme §11) — numéro, description, nombre
 * d'articles : toujours les valeurs réellement enregistrées, jamais une estimation ou un texte
 * généré par l'IA (cf. commentaire de tête de notifyShopUsersOfOrderCreated). */
function orderSummaryHtml(orders) {
  return orders
    .map((o) => `<li><strong>Commande ${o.rposOrderReference || o.rposOrderId}</strong> — ${o.department} : ${o.linesTotal - o.linesFailed} article(s) commandé(s)${o.linesFailed ? ` (${o.linesFailed} refusé(s) par RPOS)` : ''}</li>`)
    .join('');
}

/** Bon(s) de commande PDF des commandes créées, en pièces jointes — un échec de récupération d'un
 * PDF (RPOS indisponible, commande déjà supprimée...) ne doit jamais empêcher l'envoi du mail
 * lui-même : cette pièce jointe est alors simplement omise. */
async function buildOrderPdfAttachments(shop, orders) {
  const attachments = [];
  for (const o of orders) {
    if (!o.rposOrderId) continue;
    try {
      const pdfBuffer = await rpos.getSupplierOrderPdf(shop.rposPosId, o.rposOrderId);
      attachments.push({
        name: `commande-${o.rposOrderReference || o.rposOrderId}.pdf`,
        contentBytes: pdfBuffer,
        contentType: 'application/pdf',
      });
    } catch (err) {
      console.error(`[proposalNotificationService] PDF introuvable pour la commande ${o.rposOrderId}:`, err.message);
    }
  }
  return attachments;
}

/**
 * Alerte email quand une ou plusieurs commandes fournisseur sont créées sur RPOS (validation
 * manuelle OU Mode Auto, demande du 25/09/2026), avec le(s) bon(s) de commande PDF en pièce
 * jointe. Tous les chiffres du corps du mail (numéro, nombre d'articles) viennent directement des
 * ProposalOrder déjà enregistrées — jamais inventés par l'IA, même dans la variante "Mode Auto" :
 * seule la phrase d'introduction y est confiée (isAutoMode=true), et elle ne doit jamais elle-même
 * énoncer un chiffre précis (un LLM peut se tromper sur un total, jamais sur une tournure de
 * phrase). Si l'appel IA échoue (clé manquante/quota...), une phrase fixe de repli est utilisée à
 * la place — l'envoi du mail ne doit jamais dépendre de la disponibilité d'une clé IA.
 */
async function notifyShopUsersOfOrderCreated(shop, proposal, orders, { isAutoMode = false } = {}) {
  const users = await getShopRecipientUsers(shop.rposShopId);
  if (!users.length || !orders.length) return;

  let introText;
  if (isAutoMode) {
    try {
      const { streamWithFallback } = require('./aiForecastService');
      const prompt = `Rédige une seule phrase courte (une vingtaine de mots maximum), en français, pour introduire un email professionnel annonçant qu'une commande de réassort a été validée et envoyée automatiquement par le système d'IA pour le magasin ${shop.reference} (${shop.name}). Ne mentionne AUCUN chiffre précis (ni nombre d'articles, ni numéro de commande, ni montant) : ces détails sont ajoutés séparément après ta phrase. Réponds uniquement avec la phrase, sans guillemets ni mise en forme.`;
      const { fullText } = await streamWithFallback(prompt, () => {}, 'auto-order-email-intro');
      introText = fullText.trim();
    } catch (err) {
      console.error('[proposalNotificationService] Intro IA du mail Mode Auto indisponible, repli sur texte fixe:', err.message);
      introText = 'Le Mode Auto a validé et envoyé automatiquement la proposition de commande suivante.';
    }
  } else {
    introText = `La proposition de commande du magasin <strong>${shop.reference} — ${shop.name}</strong> a été validée et envoyée à l'entrepôt.`;
  }

  // Les pièces jointes PDF sont récupérées UNE SEULE FOIS (pas par destinataire) : identiques pour
  // tout le monde, un appel RPOS répété par personne serait un gaspillage inutile.
  const attachments = await buildOrderPdfAttachments(shop, orders);

  await sendMailToEachRecipient(users, async (user) => ({
    subject: `${isAutoMode ? '🤖 ' : ''}Réassort Automatique — commande créée pour ${shop.reference} (${shop.name})`,
    htmlBody: `
      <p>Bonjour ${user.name},</p>
      <p>${introText}</p>
      <ul>${orderSummaryHtml(orders)}</ul>
      <p>Le bon de commande PDF de chaque commande est joint à cet email.</p>
      <p><a href="${purchaseOrderLink(shop)}">${purchaseOrderLink(shop)}</a></p>
    `,
    attachments,
  }));
}

module.exports = {
  getShopRecipients,
  getShopRecipientUsers,
  purchaseOrderLink,
  buildSupplierWarningHtml,
  notifyShopUsersOfNewProposal,
  notifyShopUsersOfPendingProposal,
  notifyShopUsersOfOrderCreated,
};
