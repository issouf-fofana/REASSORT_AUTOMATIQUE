/**
 * Alertes email des ruptures de stock en cours (demande explicite du 18/10/2026 : "je veux quil ai
 * une partie la possibilité de faire un mail auto au magasin sil ya des article qui son en rupture
 * ou quoi de deja en rupture... il doit etre alecter pour ca aussi tu comprend ? meme si ya une
 * propostion de commande") — un magasin avec des ruptures EN_COURS reçoit un récap par email, QUE
 * ces articles aient déjà une commande en cours ou non : une commande passée ne fait pas disparaître
 * la rupture tant qu'elle n'est pas livrée, le magasin doit rester informé de la situation réelle en
 * rayon. Même pattern que proposalNotificationService.js (destinataires, envoi individuel,
 * template).
 */
const prisma = require('../utils/prisma');
const outlookMailService = require('./outlookMailService');
const { renderMailTemplate } = require('./mailTemplateService');
const { getShopRecipientUsers, getAdminUsers, sendMailToEachRecipient } = require('./proposalNotificationService');

function stockoutsLink(shop) {
  const origins = (process.env.FRONTEND_URL || 'https://reassort.local').split(',').map((o) => o.trim()).filter(Boolean);
  const isLocalhost = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(o);
  const configured = origins.find((o) => !isLocalhost(o)) || origins[0] || 'https://reassort.local';
  return `${configured}/stockouts?shop=${encodeURIComponent(shop.rposShopId)}&src=email`;
}

function formatDuration(hours) {
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.floor(hours / 24);
  const rest = Math.round(hours % 24);
  return `${days} j ${rest} h`;
}

/** Tableau HTML des articles en rupture, triés par durée décroissante — plafonné à 20 lignes
 * (même logique que buildSupplierWarningHtml : un email lisible, le détail complet reste dans
 * l'appli). Affiche explicitement le statut commande/livraison pour chaque ligne : le magasin doit
 * voir d'un coup d'œil si la rupture est déjà couverte par une commande ou non. */
function buildEpisodeTableHtml(episodes) {
  const sorted = [...episodes].sort((a, b) => b.durationHours - a.durationHours);
  const shown = sorted.slice(0, 20);
  const rows = shown
    .map((e) => {
      const orderLabel = !e.hasOrder ? 'Sans commande' : e.deliveryStatus === 'LIVREE' ? 'Livrée' : 'Commandée, pas livrée';
      const orderColor = !e.hasOrder ? '#b45309' : e.deliveryStatus === 'LIVREE' ? '#2d6a3f' : '#2e4870';
      return `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${e.label || e.ean}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${e.department || 'Sans rayon'}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;">${formatDuration(e.durationHours)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;color:${orderColor};font-weight:bold;">${orderLabel}</td>
        </tr>`;
    })
    .join('');

  const moreNote = episodes.length > shown.length
    ? `<p style="color:#9198a1;font-size:12px;">+ ${episodes.length - shown.length} autre(s) article(s) en rupture, voir le détail dans l'application.</p>`
    : '';

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;margin:16px 0;">
      <thead>
        <tr style="background:#f4f6f9;">
          <th style="padding:6px 8px;text-align:left;">Article</th>
          <th style="padding:6px 8px;text-align:left;">Rayon</th>
          <th style="padding:6px 8px;text-align:left;">Depuis</th>
          <th style="padding:6px 8px;text-align:left;">Statut commande</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${moreNote}
  `;
}

/** Envoie, pour UN magasin, un récap des ruptures EN_COURS à ses destinataires habituels
 * (getShopRecipientUsers — mêmes comptes que les alertes de proposition). N'envoie rien si le
 * magasin n'a aucune rupture ouverte. `episodes` : résultat déjà chargé par l'appelant (job), jamais
 * recalculé ici — cette fonction ne fait qu'émettre l'email.
 *
 * includeAdmins: false (demande explicite du 19/10/2026 : "pour chaque mail de rupture l'admin
 * recoit un par mag donc corrige il doit recevoir un seul pour synthese comme pour les commande...
 * c'est le mag qui recoit un mail pour lui et l'admin un mail global pour tout") — même principe déjà
 * appliqué à notifyShopUsersOfNewProposal (proposalNotificationService.js) : l'admin ne doit plus
 * recevoir une copie de CHAQUE email magasin (jusqu'à 50+ sur un réseau), mais un seul récap global
 * en fin de job (cf. notifyAdminsOfStockoutSummary ci-dessous). */
async function notifyShopOfOpenStockouts(shop, episodes) {
  if (!episodes.length) return { sent: false, recipientCount: 0 };

  const users = await getShopRecipientUsers(shop.rposShopId, { includeAdmins: false });
  if (!users.length) return { sent: false, recipientCount: 0 };

  const withoutOrder = episodes.filter((e) => !e.hasOrder).length;
  const link = stockoutsLink(shop);
  const tableHtml = buildEpisodeTableHtml(episodes);

  for (const user of users) {
    try {
      await outlookMailService.sendMail({
        to: user.email,
        subject: `Réassort Automatique — ${episodes.length} rupture(s) de stock en cours sur ${shop.reference} (${shop.name})`,
        htmlBody: renderMailTemplate(
          'Ruptures de stock en cours',
          `
            <p>Bonjour ${user.name},</p>
            <p>Le magasin <strong>${shop.reference} — ${shop.name}</strong> compte actuellement
            <strong>${episodes.length}</strong> article(s) en rupture de stock,
            dont <strong>${withoutOrder}</strong> sans commande passée.</p>
            <p>Une rupture reste signalée tant que l'article n'est pas revenu en stock, même si une
            commande a déjà été passée dessus (livraison en attente).</p>
            ${tableHtml}
          `,
          { severity: withoutOrder > 0 ? 'warning' : 'info', cta: { label: 'Voir les ruptures', url: link } },
        ),
      });
    } catch (err) {
      console.error(`[stockoutNotificationService] Envoi échoué pour ${user.email}:`, err.message);
    }
  }

  return { sent: true, recipientCount: users.length };
}

/** Récap unique envoyé aux ADMIN à la fin du job d'alerte ruptures (demande explicite du
 * 19/10/2026) — remplace la copie individuelle de chaque email magasin, même principe que
 * notifyAdminsOfNightlySummary (proposalNotificationService.js). `summaries` : tableau construit par
 * le job au fil du traitement de chaque magasin, `{ shop: {reference, name}, episodeCount,
 * withoutOrderCount }`. N'envoie rien si aucun magasin n'a de rupture en cours (tableau vide) — un
 * récap vide n'a aucune valeur. */
async function notifyAdminsOfStockoutSummary(summaries) {
  const nonEmpty = summaries.filter((s) => s.episodeCount > 0);
  if (!nonEmpty.length) return;

  const admins = await getAdminUsers();
  if (!admins.length) return;

  const totalEpisodes = nonEmpty.reduce((sum, s) => sum + s.episodeCount, 0);
  const totalWithoutOrder = nonEmpty.reduce((sum, s) => sum + s.withoutOrderCount, 0);

  const rows = nonEmpty
    .sort((a, b) => b.episodeCount - a.episodeCount)
    .map((s) => `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;">${s.shop.reference} — ${s.shop.name}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${s.episodeCount}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;">${s.withoutOrderCount ? `⚠️ ${s.withoutOrderCount}` : '—'}</td>
      </tr>
    `)
    .join('');

  const tableHtml = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin-top:12px;font-family:Arial,sans-serif;font-size:13px;">
      <thead>
        <tr style="background:#f4f6f9;">
          <th style="padding:6px 8px;text-align:left;">Magasin</th>
          <th style="padding:6px 8px;text-align:right;">Ruptures en cours</th>
          <th style="padding:6px 8px;text-align:right;">Sans commande</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  await sendMailToEachRecipient(admins, async (user) => ({
    subject: `Réassort Automatique — récap ruptures (${nonEmpty.length} magasin(s), ${totalEpisodes} rupture(s) au total)`,
    htmlBody: renderMailTemplate(
      'Récap des ruptures de stock en cours',
      `
        <p>Bonjour ${user.name},</p>
        <p><strong>${nonEmpty.length}</strong> magasin(s) ont des ruptures de stock en cours, pour un
        total de <strong>${totalEpisodes}</strong> article(s)${totalWithoutOrder ? `, dont <strong>${totalWithoutOrder}</strong> sans commande passée sur l'ensemble des magasins` : ''}.</p>
        ${tableHtml}
      `,
      { severity: totalWithoutOrder > 0 ? 'warning' : 'info' },
    ),
  }));
}

module.exports = { notifyShopOfOpenStockouts, notifyAdminsOfStockoutSummary };
