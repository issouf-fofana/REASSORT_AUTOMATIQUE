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
const { renderMailTemplate } = require('./mailTemplateService');

/** Comptes à alerter pour un magasin donné : rattachement direct (DIRECTOR/DEPARTMENT_HEAD/
 * SHELF_STOCKER) + SUPERVISOR qui le couvrent. Les ADMIN ne sont PLUS inclus ici depuis le
 * 26/09/2026 ("il ne dois pas envoyer à admin en même temps [...] impossible de lire tout") — un
 * admin recevait un email par magasin à CHAQUE génération nocturne (jusqu'à 50+ emails), illisible
 * en pratique. Un admin reçoit désormais UN SEUL récap global à la fin du job nocturne (cf.
 * notifyAdminsOfNightlySummary) plutôt qu'une copie de chaque email individuel — et reste inclus
 * pour les alertes ponctuelles (relance, commande créée, envoi manuel), dont le volume reste faible.
 * Renvoie les emails seuls (compatibilité avec les appelants existants qui n'ont besoin que de ça,
 * ex: la popup "retirer un destinataire") — cf. getShopRecipientUsers ci-dessous pour la version avec
 * le nom, nécessaire à la salutation personnalisée ("Bonjour <nom>", demande du 25/09/2026 : LE NOM
 * VIENT TOUJOURS du compte réel de chaque destinataire — AD ou local, jamais un nom en dur).
 * `includeAdmins` (optionnel, défaut true) : mis à false uniquement par le job nocturne pour l'email
 * de nouvelle proposition, seul cas à volume élevé — tous les autres appelants gardent le
 * comportement historique (admin toujours en copie) sans avoir besoin de changer leur appel. */
// mailAlertsEnabled=true (demande du 26/09/2026, page Destinataires email) : réglage indépendant du
// rôle/rattachement, exclut un compte de TOUTE alerte email automatique sans toucher à son accès
// applicatif (role/isActive restent la seule source de vérité pour ça, cf. schema.prisma). Appliqué
// systématiquement ici plutôt que dans chaque appelant : un seul point de vérité pour cette règle.
async function getShopRecipientUsers(rposShopId, { includeAdmins = true } = {}) {
  const [directUsers, supervisors, admins] = await Promise.all([
    prisma.user.findMany({ where: { rposShopId, isActive: true, mailAlertsEnabled: true }, select: { email: true, name: true } }),
    prisma.user.findMany({
      where: { role: 'SUPERVISOR', isActive: true, mailAlertsEnabled: true, supervisedShops: { some: { rposShopId } } },
      select: { email: true, name: true },
    }),
    includeAdmins
      ? prisma.user.findMany({ where: { role: 'ADMIN', isActive: true, mailAlertsEnabled: true }, select: { email: true, name: true } })
      : Promise.resolve([]),
  ]);
  const byEmail = new Map();
  for (const u of [...directUsers, ...supervisors, ...admins]) byEmail.set(u.email, u);
  return [...byEmail.values()];
}

async function getShopRecipients(rposShopId) {
  return (await getShopRecipientUsers(rposShopId)).map((u) => u.email);
}

/** Tous les comptes ADMIN actifs ET non exclus des alertes email — destinataires du récap global de
 * fin de nuit (cf. notifyAdminsOfNightlySummary). Séparé de getShopRecipientUsers car indépendant de
 * tout magasin. */
async function getAdminUsers() {
  return prisma.user.findMany({ where: { role: 'ADMIN', isActive: true, mailAlertsEnabled: true }, select: { email: true, name: true } });
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

/** FRONTEND_URL peut contenir plusieurs origines séparées par des virgules (même format que
 * CORS_ORIGIN, ex: "http://localhost:8080,http://10.0.80.31:8080" pour accepter les deux façons
 * d'atteindre le site) — un lien dans un email ne peut pointer que vers UNE seule URL, jamais les
 * coller ensemble (bug constaté le 25/09/2026 : lien illisible et non cliquable dans Outlook,
 * "[url1]url2" concaténés).
 * Prendre systématiquement la PREMIÈRE valeur (comme avant le 26/09/2026) est erroné dès que cette
 * première valeur est "localhost" : ce mot ne désigne le serveur QUE depuis le poste qui l'héberge
 * lui-même, jamais depuis la machine du destinataire d'un email (bug constaté le 26/09/2026, lien
 * "http://localhost:8080/..." reçu dans un vrai email, inutilisable pour quiconque d'autre que le
 * serveur). On retient donc la première origine qui N'EST PAS localhost/127.0.0.1, seule capable
 * d'avoir un sens pour un destinataire externe — et seulement si aucune n'en sort, on retombe sur la
 * première quand même (mieux qu'un lien totalement absent).
 */
// `src=email` (demande du 26/09/2026 : "si admin est connecté il va sur une commande mais dans un
// autre mag") : marque explicitement ce lien comme venant d'un clic dans un email — le frontend
// (PurchaseOrder.tsx) doit alors laisser CE magasin gagner sur le magasin actif mémorisé de la
// topbar, qui peut dater d'une session précédente sans rapport. Sans ce marqueur, un ADMIN qui
// consultait un autre magasin juste avant de cliquer sur le lien atterrissait sur CE magasin actif
// au lieu de celui visé par l'email — la protection ajoutée le 24/09/2026 contre une URL périmée
// restée ouverte dans un onglet s'appliquait à tort à un lien fraîchement cliqué depuis un email.
function purchaseOrderLink(shop) {
  const origins = (process.env.FRONTEND_URL || 'https://reassort.local').split(',').map((o) => o.trim()).filter(Boolean);
  const isLocalhost = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(o);
  const configured = origins.find((o) => !isLocalhost(o)) || origins[0] || 'https://reassort.local';
  return `${configured}/purchase-order?shop=${encodeURIComponent(shop.rposShopId)}&src=email`;
}

/** Nombre d'articles non rattachés au fournisseur central RPOS, et résumé HTML correspondant (jamais
 * la liste détaillée) — demande du 26/09/2026 : "quand il liste comme ça c'est pas joli à voir, le
 * mail devient compliqué à lire" (jusqu'à 26 articles listés un par un dans un email précédent). Le
 * détail complet est désormais visible directement dans la page Proposition de commande (bandeau
 * ⚠️), le mail se contente d'alerter et de renvoyer vers cette vue. Un échec de ce contrôle (RPOS
 * indisponible...) ne doit jamais empêcher l'envoi du mail lui-même : le résumé est alors omis
 * plutôt que de bloquer toute la notification. Renvoie aussi `count` (jamais recalculé une seconde
 * fois par l'appelant, ex: pour construire le récap admin de fin de nuit).
 */
async function buildSupplierWarningHtml(shop, lines, link) {
  try {
    const ineligible = await checkSupplierEligibility(shop.rposPosId, shop.rposShopId, lines);
    if (!ineligible.length) return { html: '', count: 0 };
    return {
      html: `
        <p style="color:#b45309;"><strong>⚠️ ${ineligible.length} article(s) non rattaché(s) au fournisseur central</strong> —
        risque qu'ils manquent à l'envoi réel de la commande. <a href="${link}">Voir le détail dans la proposition</a>.</p>
      `,
      count: ineligible.length,
    };
  } catch (err) {
    console.error(`[proposalNotificationService] Contrôle fournisseur échoué pour ${shop.reference}:`, err.message);
    return { html: '', count: 0 };
  }
}

/** Alerte de nouvelle proposition générée (job nocturne) — jamais sur une génération manuelle.
 * Un email individuel par destinataire (demande du 25/09/2026), avec son vrai nom en salutation.
 * N'inclut PLUS les ADMIN (demande du 26/09/2026, cf. commentaire de getShopRecipientUsers) : ils
 * reçoivent à la place un récap unique en fin de job (cf. notifyAdminsOfNightlySummary), pour lequel
 * cette fonction renvoie le nombre d'articles non rattachés au fournisseur déjà calculé ici — évite
 * de refaire le même appel RPOS coûteux une seconde fois côté job pour construire ce récap. */
async function notifyShopUsersOfNewProposal(shop, stats, proposal) {
  const users = await getShopRecipientUsers(shop.rposShopId, { includeAdmins: false });

  const link = purchaseOrderLink(shop);
  const { html: supplierWarningHtml, count: ineligibleCount } = await buildSupplierWarningHtml(shop, proposal.lines, link);

  if (!users.length) return { ineligibleCount };

  await sendMailToEachRecipient(users, async (user) => ({
    subject: `Réassort Automatique — nouvelle proposition pour ${shop.reference} (${shop.name})`,
    htmlBody: renderMailTemplate(
      'Nouvelle proposition de commande',
      `
        <p>Bonjour ${user.name},</p>
        <p>Une nouvelle proposition de commande vient d'être générée pour le magasin <strong>${shop.reference} — ${shop.name}</strong>.</p>
        <p><strong>${stats.proposalsGenerated}</strong> article(s) proposé(s).</p>
        ${supplierWarningHtml}
        <p>Merci de vous connecter pour vérifier et valider cette commande.</p>
      `,
      { severity: 'info', cta: { label: 'Voir la commande', url: link } },
    ),
  }));

  return { ineligibleCount };
}

/**
 * Récap unique envoyé aux ADMIN à la fin du job nocturne (demande du 26/09/2026) — remplace la copie
 * individuelle de chaque email par magasin (jusqu'à 50+ emails en une nuit, illisible). `summaries`
 * est un tableau construit par le job au fil du traitement de chaque magasin :
 * `{ shop: {reference, name}, proposalsGenerated, ineligibleCount }`. N'envoie RIEN si aucun magasin
 * n'a produit de proposition cette nuit (tableau vide) — un récap vide n'a aucune valeur.
 */
async function notifyAdminsOfNightlySummary(summaries) {
  const nonEmpty = summaries.filter((s) => s.proposalsGenerated > 0);
  if (!nonEmpty.length) return;

  const admins = await getAdminUsers();
  if (!admins.length) return;

  const totalArticles = nonEmpty.reduce((sum, s) => sum + s.proposalsGenerated, 0);
  const totalIneligible = nonEmpty.reduce((sum, s) => sum + (s.ineligibleCount || 0), 0);

  const rows = nonEmpty
    .map((s) => `
      <tr>
        <td>${s.shop.reference} — ${s.shop.name}</td>
        <td style="text-align:right;">${s.proposalsGenerated}</td>
        <td style="text-align:right;">${s.ineligibleCount ? `⚠️ ${s.ineligibleCount}` : '—'}</td>
      </tr>
    `)
    .join('');

  const tableHtml = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:12px;">
      <thead>
        <tr style="border-bottom:2px solid #ececec;">
          <th style="text-align:left;padding:6px 8px;">Magasin</th>
          <th style="text-align:right;padding:6px 8px;">Articles proposés</th>
          <th style="text-align:right;padding:6px 8px;">Non rattachés fournisseur</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  await sendMailToEachRecipient(admins, async (user) => ({
    subject: `Réassort Automatique — récap nocturne (${nonEmpty.length} magasin(s), ${totalArticles} article(s))`,
    htmlBody: renderMailTemplate(
      'Récap de la génération nocturne',
      `
        <p>Bonjour ${user.name},</p>
        <p><strong>${nonEmpty.length}</strong> magasin(s) ont une nouvelle proposition cette nuit, pour un total de <strong>${totalArticles}</strong> article(s) proposé(s)${totalIneligible ? `, dont <strong>${totalIneligible}</strong> non rattaché(s) au fournisseur central sur l'ensemble des magasins` : ''}.</p>
        ${tableHtml}
      `,
      { severity: totalIneligible ? 'warning' : 'info' },
    ),
  }));
}

/** Relance pour une proposition GENERATED encore en attente (job de 10h, demande du 25/09/2026 :
 * "les alertes peuvent être entre 9h et 11h", l'entrepôt ne reçoit plus les commandes après 13h).
 * Gravité volontairement plus marquée que le mail initial (couleur rouge, mention explicite du
 * délai) pour se distinguer visuellement d'une simple information. Un email individuel par
 * destinataire (demande du 25/09/2026), avec son vrai nom en salutation.
 * `overrideRecipientEmails` (optionnel) : liste d'emails choisie à la main (popup de confirmation
 * avant l'envoi manuel, demande du 25/09/2026 — "les enlever ou pas") — filtre la liste calculée
 * automatiquement.
 * `includeAdmins` (optionnel, défaut true) : mis à false uniquement par le job planifié de relance
 * (demande du 26/09/2026, même raison que notifyShopUsersOfNewProposal — "à la fin de l'opération je
 * dois recevoir un mail pas plusieurs") : l'admin reçoit désormais UN récap en fin de job plutôt
 * qu'une copie de chaque relance individuelle. L'envoi manuel depuis la page Proposition de commande
 * garde l'admin en copie par défaut (volume faible, un seul magasin à la fois). */
async function notifyShopUsersOfPendingProposal(shop, proposal, overrideRecipientEmails, { includeAdmins = true } = {}) {
  let users = await getShopRecipientUsers(shop.rposShopId, { includeAdmins });
  if (overrideRecipientEmails) users = users.filter((u) => overrideRecipientEmails.includes(u.email));
  if (!users.length) return;

  const link = purchaseOrderLink(shop);

  await sendMailToEachRecipient(users, async (user) => ({
    subject: `⚠️ Rappel urgent — proposition non validée pour ${shop.reference} (${shop.name})`,
    htmlBody: renderMailTemplate(
      '⚠️ Rappel urgent',
      `
        <p>Bonjour ${user.name},</p>
        <p style="color:#c0392b;"><strong>La proposition de commande du magasin ${shop.reference} — ${shop.name} n'est toujours pas validée.</strong></p>
        <p><strong>${proposal.lines.length}</strong> article(s) en attente de vérification.</p>
        <p style="color:#c0392b;">L'entrepôt ne reçoit plus les commandes après <strong>13h</strong> — au-delà, cette commande sera traitée le lendemain.</p>
        <p>Merci de vous connecter dès que possible pour vérifier et valider cette commande.</p>
      `,
      { severity: 'danger', cta: { label: 'Valider maintenant', url: link } },
    ),
  }));
}

/**
 * Récap unique envoyé aux ADMIN à la fin du job de relance (demande du 26/09/2026, même principe
 * que notifyAdminsOfNightlySummary) — remplace la copie individuelle de chaque relance par magasin.
 * `summaries` : tableau `{ shop: {reference, name}, articlesPending }` construit par le job.
 */
async function notifyAdminsOfReminderSummary(summaries) {
  if (!summaries.length) return;

  const admins = await getAdminUsers();
  if (!admins.length) return;

  const totalArticles = summaries.reduce((sum, s) => sum + s.articlesPending, 0);

  const rows = summaries
    .map((s) => `
      <tr>
        <td>${s.shop.reference} — ${s.shop.name}</td>
        <td style="text-align:right;">${s.articlesPending}</td>
      </tr>
    `)
    .join('');

  const tableHtml = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:12px;">
      <thead>
        <tr style="border-bottom:2px solid #ececec;">
          <th style="text-align:left;padding:6px 8px;">Magasin</th>
          <th style="text-align:right;padding:6px 8px;">Articles en attente</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  await sendMailToEachRecipient(admins, async (user) => ({
    subject: `⚠️ Réassort Automatique — récap relance (${summaries.length} magasin(s) non validé(s))`,
    htmlBody: renderMailTemplate(
      '⚠️ Récap des propositions non validées',
      `
        <p>Bonjour ${user.name},</p>
        <p><strong>${summaries.length}</strong> magasin(s) ont encore une proposition non validée, pour un total de <strong>${totalArticles}</strong> article(s) en attente. L'entrepôt ne reçoit plus les commandes après <strong>13h</strong>.</p>
        ${tableHtml}
      `,
      { severity: 'danger' },
    ),
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
    htmlBody: renderMailTemplate(
      `${isAutoMode ? '🤖 ' : ''}Commande créée`,
      `
        <p>Bonjour ${user.name},</p>
        <p>${introText}</p>
        <ul>${orderSummaryHtml(orders)}</ul>
        <p>Le bon de commande PDF de chaque commande est joint à cet email.</p>
      `,
      { severity: 'info', cta: { label: 'Voir la commande', url: purchaseOrderLink(shop) } },
    ),
    attachments,
  }));
}

module.exports = {
  getShopRecipients,
  getShopRecipientUsers,
  getAdminUsers,
  purchaseOrderLink,
  buildSupplierWarningHtml,
  notifyShopUsersOfNewProposal,
  notifyAdminsOfNightlySummary,
  notifyShopUsersOfPendingProposal,
  notifyAdminsOfReminderSummary,
  notifyShopUsersOfOrderCreated,
};
