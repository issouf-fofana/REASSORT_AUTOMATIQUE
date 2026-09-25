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

const TOKEN_TIMEOUT_MS = 15000;
const SEND_TIMEOUT_MS = 20000;

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

/** Envoie un email HTML via Microsoft Graph (POST /me/sendMail) avec le compte actif configuré. */
async function sendMail({ to, subject, htmlBody }) {
  const account = await getActiveAccount();
  if (!account) throw new Error('Aucun compte mail actif configuré (Paramètres > Comptes mail).');

  const accessToken = await getAccessToken(account);

  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean).map((email) => ({ emailAddress: { address: email } }));
  if (!recipients.length) throw new Error('Aucun destinataire fourni.');

  const res = await fetchWithTimeout(
    'https://graph.microsoft.com/v1.0/me/sendMail',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject,
          body: { contentType: 'HTML', content: htmlBody },
          toRecipients: recipients,
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
