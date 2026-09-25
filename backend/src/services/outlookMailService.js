/**
 * Envoi d'emails via Microsoft Graph (compte Outlook/Office 365 configuré dans Paramètres >
 * Comptes mail, demande du 25/09/2026) — utilisé pour alerter les comptes rattachés à un magasin
 * dès qu'une génération nocturne produit une proposition de commande à vérifier/valider.
 *
 * Flow OAuth2 "refresh_token" (délégué, pas client-credentials) : le refresh token est obtenu une
 * fois manuellement (consentement Azure AD côté ia.prosuma@prosuma.ci), collé dans Paramètres, puis
 * échangé ici à chaque envoi contre un access token de courte durée — jamais mis en cache entre deux
 * envois pour rester simple (un envoi par magasin la nuit, pas un volume qui justifierait un cache).
 */
const prisma = require('../utils/prisma');
const crypto = require('./cryptoService');
const systemConfig = require('./systemConfigService');

const TOKEN_TIMEOUT_MS = 15000;
const SEND_TIMEOUT_MS = 20000;
const LOGO_CONTENT_ID = 'reassort-mail-logo';

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Compte actif unique (V1, cf. schema.prisma) — null si aucun compte configuré/activé. */
async function getActiveAccount() {
  return prisma.mailAccount.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'asc' } });
}

/** Échange le refresh token contre un access token Microsoft Graph (scope Mail.Send délégué). */
async function getAccessToken(account) {
  if (!account.encryptedRefreshToken) {
    throw new Error("Ce compte n'est pas encore connecté à Outlook — utilisez le bouton \"Connecter Outlook\" dans Paramètres.");
  }
  const clientSecret = crypto.decrypt(account.encryptedClientSecret);
  const refreshToken = crypto.decrypt(account.encryptedRefreshToken);

  const body = new URLSearchParams({
    client_id: account.clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: 'https://graph.microsoft.com/Mail.Send offline_access',
  });

  const res = await fetchWithTimeout(
    `https://login.microsoftonline.com/${account.tenantId}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    TOKEN_TIMEOUT_MS,
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || `Échec d'authentification Azure (HTTP ${res.status})`);
  return json.access_token;
}

/** Pied de page signature/logo (demande du 25/09/2026, configurable dans Paramètres > Comptes
 * mail) — signature en texte simple (jamais de HTML brut accepté, une balise mal fermée casserait
 * l'affichage de TOUS les emails envoyés par cette plateforme) converti en <br> pour les retours à
 * la ligne ; logo joint en pièce jointe INLINE (Content-ID), jamais via une URL publique — évite
 * d'exposer un nouvel endpoint de fichiers statiques juste pour cette image, et le logo reste
 * visible même si le destinataire bloque les images distantes (cas fréquent des clients mail).
 * Silencieux si rien n'est configuré : le mail part sans pied de page, comme avant cette fonction. */
async function buildSignatureFooter() {
  const [signatureText, logoBase64, logoContentType] = await Promise.all([
    systemConfig.getValue(systemConfig.KEYS.MAIL_SIGNATURE_TEXT),
    systemConfig.getValue(systemConfig.KEYS.MAIL_LOGO_BASE64),
    systemConfig.getValue(systemConfig.KEYS.MAIL_LOGO_CONTENT_TYPE),
  ]);

  if (!signatureText && !logoBase64) return { footerHtml: '', logoAttachment: null };

  const escapedSignature = (signatureText || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .split('\n').join('<br>');

  const logoImgHtml = logoBase64 ? `<img src="cid:${LOGO_CONTENT_ID}" alt="Logo" style="max-height:60px;display:block;margin-bottom:8px;">` : '';

  const footerHtml = `
    <hr style="margin-top:24px;border:none;border-top:1px solid #e5e5e5;">
    <table role="presentation" style="margin-top:12px;font-family:sans-serif;font-size:13px;color:#555;">
      <tr><td>${logoImgHtml}${escapedSignature}</td></tr>
    </table>
  `;

  const logoAttachment = logoBase64
    ? {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'logo.png',
        contentType: logoContentType || 'image/png',
        contentBytes: logoBase64,
        contentId: LOGO_CONTENT_ID,
        isInline: true,
      }
    : null;

  return { footerHtml, logoAttachment };
}

/**
 * Envoi avec pièce(s) jointe(s) (demande du 25/09/2026 : PDF du bon de commande en pièce jointe
 * quand une commande est créée) — Microsoft Graph attend chaque pièce jointe en base64 inline dans
 * le corps JSON de la requête (fileAttachment), pas un upload séparé : suffisant pour un PDF de
 * quelques dizaines de Ko, jamais des fichiers volumineux avec ce système. Le pied de page
 * signature/logo (Paramètres > Comptes mail) est ajouté automatiquement à CHAQUE email envoyé par
 * cette fonction, y compris le test — un appelant n'a jamais à s'en soucier.
 * @param {{name: string, contentBytes: Buffer, contentType?: string}[]} [attachments]
 */
async function sendMail({ to, subject, htmlBody, attachments = [] }) {
  const account = await getActiveAccount();
  if (!account) throw new Error('Aucun compte mail actif configuré (Paramètres > Comptes mail).');

  const accessToken = await getAccessToken(account);

  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map((email) => ({ emailAddress: { address: email } }));
  if (!recipients.length) throw new Error('Aucun destinataire fourni.');

  const { footerHtml, logoAttachment } = await buildSignatureFooter();
  const fullHtmlBody = htmlBody + footerHtml;

  const graphAttachments = [
    ...attachments.map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.name,
      contentType: a.contentType || 'application/octet-stream',
      contentBytes: a.contentBytes.toString('base64'),
    })),
    ...(logoAttachment ? [logoAttachment] : []),
  ];

  const res = await fetchWithTimeout(
    'https://graph.microsoft.com/v1.0/me/sendMail',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: fullHtmlBody },
          toRecipients: recipients,
          ...(graphAttachments.length ? { attachments: graphAttachments } : {}),
        },
        saveToSentItems: true,
      }),
    },
    SEND_TIMEOUT_MS,
  );

  if (!res.ok) {
    let message = `Échec d'envoi Graph (HTTP ${res.status})`;
    try {
      const json = await res.json();
      message = json.error?.message || message;
    } catch {
      // corps non-JSON, on garde le message générique
    }
    throw new Error(message);
  }
}

/** Envoi de test (bouton "Tester" de Paramètres > Comptes mail) : mail court au compte lui-même. */
async function sendTestMail() {
  const account = await getActiveAccount();
  if (!account) throw new Error('Aucun compte mail actif configuré.');
  await sendMail({
    to: account.email,
    subject: 'Réassort Automatique — test de connexion',
    htmlBody: '<p>Ce message confirme que la connexion Outlook de Réassort Automatique fonctionne correctement.</p>',
  });
}

module.exports = { sendMail, sendTestMail, getActiveAccount };
