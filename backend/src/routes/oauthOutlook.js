// Flux OAuth2 "authorization code" Microsoft Graph pour obtenir le refresh token du compte
// d'alerte Outlook (demande du 25/09/2026 : éviter de faire copier-coller un token à la main dans
// Paramètres > Comptes mail). Monté en dehors de /api/reassort (pas de requireAuth Bearer classique
// possible ici : Azure redirige le NAVIGATEUR de l'admin vers /callback avec un ?code=, sans jamais
// transmettre notre propre JWT) — protégé autrement :
//   - /start exige quand même une session ADMIN (JWT classique en query, lu une seule fois),
//     puis encode l'identité de l'appelant + le compte mail ciblé dans un state JWT signé
//     (courte durée de vie) transmis à Azure et renvoyé tel quel au callback ;
//   - /callback ne fait confiance à aucune donnée non signée : il revérifie ce state avant
//     d'écrire quoi que ce soit en base, donc un tiers qui devinerait l'URL de callback ne peut
//     rien déclencher sans un state valide qu'il n'a aucun moyen de forger sans JWT_SECRET.
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const cryptoService = require('../services/cryptoService');
const { getJwtConfig } = require('../services/jwtConfigService');

// Secret dédié au `state` OAuth (distinct du secret JWT de session, lui dynamique en base via
// getJwtConfig — cf. requireAuth) : ce state ne fait que transiter par Azure aller-retour dans une
// même requête HTTP, jamais stocké ni présenté comme preuve d'identité ailleurs, un secret fixe issu
// de l'environnement suffit à empêcher qu'un tiers le forge.
const STATE_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';
const STATE_TTL_SECONDS = 600; // 10 minutes : largement suffisant pour le temps de se connecter/consentir sur login.microsoftonline.com

function backendPublicUrl() {
  // OAUTH_REDIRECT_BASE_URL doit correspondre EXACTEMENT au Redirect URI déjà enregistré côté
  // Azure AD (Authentication > Redirect URIs) — ex: http://localhost:4000. Sans cette variable,
  // retombe sur l'hôte de la requête courante (pratique en dev, mais Azure exigera une correspondance
  // exacte en production : à définir explicitement dès que ce n'est plus du localhost).
  return process.env.OAUTH_REDIRECT_BASE_URL || null;
}

// GET /api/oauth/outlook/start?accountId=...&token=<JWT admin>
// Ouvert directement dans un nouvel onglet depuis Paramètres > Comptes mail (pas un appel fetch :
// on a besoin d'une vraie navigation de page pour que la redirection Azure suivante fonctionne).
router.get('/start', async (req, res) => {
  try {
    const { accountId, token } = req.query;
    if (!accountId || !token) return res.status(400).send('accountId et token sont requis.');

    let payload;
    try {
      const { secret } = await getJwtConfig();
      payload = jwt.verify(token, secret);
    } catch {
      return res.status(401).send('Session invalide ou expirée — reconnectez-vous puis réessayez.');
    }
    if (payload.role !== 'ADMIN') return res.status(403).send('Réservé aux administrateurs.');

    const account = await prisma.mailAccount.findUnique({ where: { id: accountId } });
    if (!account) return res.status(404).send('Compte mail introuvable.');

    const redirectBase = backendPublicUrl() || `${req.protocol}://${req.get('host')}`;
    const redirectUri = `${redirectBase}/api/oauth/outlook/callback`;

    const state = jwt.sign({ accountId, purpose: "outlook-oauth" }, STATE_SECRET, { expiresIn: STATE_TTL_SECONDS });

    const authUrl = new URL(`https://login.microsoftonline.com/${account.tenantId}/oauth2/v2.0/authorize`);
    authUrl.searchParams.set('client_id', account.clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_mode', 'query');
    authUrl.searchParams.set('scope', 'https://graph.microsoft.com/Mail.Send offline_access');
    authUrl.searchParams.set('state', state);
    // login_hint pré-remplit l'email sur l'écran de connexion Microsoft — évite de se tromper de
    // compte si l'admin est déjà connecté ailleurs avec un autre compte Microsoft dans ce navigateur.
    authUrl.searchParams.set('login_hint', account.email);

    res.redirect(authUrl.toString());
  } catch (error) {
    res.status(500).send('Erreur : ' + error.message);
  }
});

// GET /api/oauth/outlook/callback?code=...&state=...
// Appelé directement par Azure AD (redirection navigateur), jamais par le frontend.
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;
  if (error) {
    return res.status(400).send(`<h3>Connexion Outlook refusée</h3><p>${errorDescription || error}</p><p>Vous pouvez fermer cet onglet.</p>`);
  }
  if (!code || !state) return res.status(400).send('Paramètres manquants.');

  let statePayload;
  try {
    statePayload = jwt.verify(state, STATE_SECRET);
  } catch {
    return res.status(400).send('Lien expiré ou invalide — recommencez depuis Paramètres > Comptes mail.');
  }
  if (statePayload.purpose !== 'outlook-oauth') return res.status(400).send('State invalide.');

  try {
    const account = await prisma.mailAccount.findUnique({ where: { id: statePayload.accountId } });
    if (!account) return res.status(404).send('Compte mail introuvable (a-t-il été supprimé entre-temps ?).');

    const clientSecret = cryptoService.decrypt(account.encryptedClientSecret);
    const redirectBase = backendPublicUrl() || `${req.protocol}://${req.get('host')}`;
    const redirectUri = `${redirectBase}/api/oauth/outlook/callback`;

    const body = new URLSearchParams({
      client_id: account.clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      scope: 'https://graph.microsoft.com/Mail.Send offline_access',
    });

    const tokenRes = await fetch(`https://login.microsoftonline.com/${account.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(tokenJson.error_description || tokenJson.error || `Échec Azure (HTTP ${tokenRes.status})`);
    }
    if (!tokenJson.refresh_token) {
      throw new Error("Azure n'a renvoyé aucun refresh_token — vérifiez que le scope offline_access est bien accordé à l'application.");
    }

    await prisma.mailAccount.update({
      where: { id: account.id },
      data: {
        encryptedRefreshToken: cryptoService.encrypt(tokenJson.refresh_token),
        lastError: null,
        lastErrorAt: null,
      },
    });

    res.send('<h3>Connexion Outlook réussie ✅</h3><p>Le refresh token a été enregistré. Vous pouvez fermer cet onglet et retourner sur Paramètres.</p>');
  } catch (err) {
    await prisma.mailAccount
      .update({ where: { id: statePayload.accountId }, data: { lastError: err.message, lastErrorAt: new Date() } })
      .catch(() => {});
    res.status(500).send(`<h3>Échec de la connexion Outlook</h3><p>${err.message}</p>`);
  }
});

module.exports = router;
