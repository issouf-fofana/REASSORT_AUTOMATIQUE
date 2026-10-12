/**
 * Chien de garde de consommation de tokens IA (demande du 12/10/2026, suite à un pic réel de
 * 36,9M tokens en une seule journée découvert seulement après coup sur la page Consommation de
 * tokens — aucune alerte n'existait avant ce constat). Vérifie quotidiennement le total des
 * dernières 24h (AiUsageLog) et alerte les ADMIN par email si TOKEN_USAGE_ALERT_THRESHOLD_TOKENS
 * est dépassé, pour réagir en heures plutôt qu'en découvrant le pic des jours plus tard.
 */
const prisma = require('../utils/prisma');
const systemConfig = require('../services/systemConfigService');
const outlookMailService = require('../services/outlookMailService');
const { renderMailTemplate } = require('../services/mailTemplateService');
const { getAdminUsers } = require('../services/proposalNotificationService');

// Même logique que purchaseOrderLink (proposalNotificationService.js) : FRONTEND_URL peut contenir
// plusieurs origines séparées par des virgules, jamais les concaténer dans un lien d'email, et
// jamais privilégier "localhost" qui n'a de sens que depuis le serveur lui-même.
function tokenUsagePageLink() {
  const origins = (process.env.FRONTEND_URL || 'https://reassort.local').split(',').map((o) => o.trim()).filter(Boolean);
  const isLocalhost = (o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(o);
  const configured = origins.find((o) => !isLocalhost(o)) || origins[0] || 'https://reassort.local';
  return `${configured}/token-usage`;
}

async function runTokenUsageWatchdog() {
  const thresholdRaw = await systemConfig.getValue(systemConfig.KEYS.TOKEN_USAGE_ALERT_THRESHOLD_TOKENS);
  const threshold = Number(thresholdRaw) || 2000000;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const agg = await prisma.aiUsageLog.aggregate({
    where: { createdAt: { gte: since } },
    _sum: { totalTokens: true },
    _count: true,
  });
  const totalTokens = agg._sum.totalTokens || 0;
  const callCount = agg._count;

  console.log(`[tokenUsageWatchdog] ${totalTokens} token(s) sur les dernières 24h (${callCount} appel(s)), seuil=${threshold}.`);

  if (totalTokens <= threshold) {
    return { totalTokens, callCount, threshold, overThreshold: false, notified: false };
  }

  // Répartition par contexte (ex: ai-forecast-batch, chatbot-answer) pour que l'email pointe
  // directement la source du dépassement, pas juste un total brut à investiguer soi-même.
  const byContext = await prisma.aiUsageLog.groupBy({
    by: ['context'],
    where: { createdAt: { gte: since } },
    _sum: { totalTokens: true },
    orderBy: { _sum: { totalTokens: 'desc' } },
    take: 5,
  });

  const admins = await getAdminUsers();
  let notified = false;
  if (admins.length) {
    const breakdownHtml = byContext
      .map((c) => `<li>${c.context || '(non renseigné)'} : <strong>${(c._sum.totalTokens || 0).toLocaleString('fr-FR')}</strong> tokens</li>`)
      .join('');
    const htmlBody = `
      <p>La consommation de tokens IA des dernières 24h a dépassé le seuil configuré.</p>
      <p><strong>${totalTokens.toLocaleString('fr-FR')}</strong> tokens consommés (${callCount} appel(s)), seuil fixé à <strong>${threshold.toLocaleString('fr-FR')}</strong>.</p>
      <p>Principaux postes de consommation :</p>
      <ul>${breakdownHtml}</ul>
      <p>Consultez le détail heure par heure sur la page Consommation de tokens.</p>
    `;
    // Envoi individuel à chaque ADMIN (même principe que sendMailToEachRecipient ailleurs dans
    // l'app) : un échec d'envoi à un destinataire ne doit jamais empêcher les autres de recevoir
    // leur alerte, et jamais bloquer le job lui-même (l'alerte est un effet de bord, pas le run).
    for (const admin of admins) {
      try {
        const htmlFull = renderMailTemplate(
          'Pic de consommation de tokens IA détecté',
          `<p>Bonjour ${admin.name},</p>${htmlBody}`,
          { severity: 'warning', cta: { label: 'Voir la consommation de tokens', url: tokenUsagePageLink() } },
        );
        await outlookMailService.sendMail({
          to: admin.email,
          subject: `Réassort Automatique — pic de consommation de tokens IA (${totalTokens.toLocaleString('fr-FR')} tokens/24h)`,
          htmlBody: htmlFull,
        });
        notified = true;
      } catch (err) {
        console.error(`[tokenUsageWatchdog] Envoi d'alerte échoué pour ${admin.email}:`, err.message);
      }
    }
  }

  return { totalTokens, callCount, threshold, overThreshold: true, notified, byContext };
}

module.exports = { runTokenUsageWatchdog };
