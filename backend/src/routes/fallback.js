// Page de secours servie directement par le backend (sans le conteneur frontend/nginx).
//
// Contexte : en production (Dockploy), le frontend nginx sert toutes les pages et le backend
// ne fait que l'API. Mais en accès direct au backend (dev local, diagnostic réseau, frontend
// en panne), le port 3001 n'affichait qu'une 404 JSON sur /. Ce routeur sert un fallback
// minimal — tableau de bord (/) et connexion (/login) — pour garder un accès de secours.
//
// Contenu servi : copies FIGÉES de frontend/index.html et frontend/auth-signin.html + leurs
// dépendances (assets listés dans scripts/syncFallback.js), synchronisées MANUELLEMENT via
// `npm run sync-fallback` (backend/package.json). Règle : après toute modification de
// frontend/index.html, frontend/auth-signin.html (ou de leurs assets directs), relancer le
// script puis commiter le résultat. Le fallback ne remplace jamais le frontend complet :
// toute navigation interne au-delà de / et /login renvoie vers le frontend normal.
//
// Sécurité : whitelist stricte (jamais de chemin arbitraire), aucun secret embarqué
// (backend-config.js du fallback pointe vers le backend lui-même, voir syncFallback.js).
const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const FALLBACK_DIR = path.join(__dirname, '..', '..', 'public-fallback');

// URL → fichier servi (whitelist fermée : jamais de chemin fourni par le client).
const FALLBACK_PAGES = {
  '/': 'index.html',
  '/index': 'index.html',
  '/index.html': 'index.html',
  '/login': 'auth-signin.html',
  '/auth-signin': 'auth-signin.html',
  '/auth-signin.html': 'auth-signin.html',
};

function serveFallbackFile(res, file) {
  const full = path.join(FALLBACK_DIR, file);
  // Garde-fou : le chemin résolu doit rester dans le dossier fallback (pas de ../).
  if (!full.startsWith(FALLBACK_DIR + path.sep)) return res.status(403).end();
  fs.access(full, fs.constants.R_OK, (err) => {
    if (err) return res.status(404).json({ success: false, message: 'Page de secours indisponible' });
    return res.sendFile(full);
  });
}

Object.keys(FALLBACK_PAGES).forEach((url) => {
  router.get(url, (req, res) => serveFallbackFile(res, FALLBACK_PAGES[url]));
});

// Assets du fallback : servis sous /assets/... UNIQUEMENT si le fichier existe dans le
// dossier fallback. Ne masque jamais l'API : ce routeur est monté AVANT les routes /api
// mais ne répond qu'aux chemins ci-dessus et aux assets existants, puis passe la main (next)
// dans tous les autres cas.
router.use('/assets', express.static(path.join(FALLBACK_DIR, 'assets')));

module.exports = router;