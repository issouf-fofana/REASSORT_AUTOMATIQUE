#!/usr/bin/env node
/**
 * Synchronise le fallback minimal servi par le backend (backend/public-fallback/)
 * depuis le frontend (frontend/), pour l'option C du ménage P1 :
 *   backend/public (36 Mo, snapshot anglais du template) → supprimé,
 *   remplacé par un fallback figé : index.html + auth-signin.html + dépendances.
 *
 * Usage :  cd backend && npm run sync-fallback
 * Règle : relancer après toute modification de frontend/index.html,
 * frontend/auth-signin.html ou de leurs assets directs, puis commiter.
 *
 * Ce que fait le script :
 *  1. recrée backend/public-fallback/ depuis zéro (supprime l'ancien contenu) ;
 *  2. copie les 2 pages + la liste fermée ASSETS ci-dessous (chemins relatifs
 *     à frontend/, conservés à l'identique pour que les URLs /assets/... restent
 *     valables quand le backend les sert) ;
 *  3. réécrit assets/js/backend-config.js dans le fallback pour pointer vers le
 *     backend lui-même (même origine, pas de CORS) : `window.REASSORT_BACKEND_URL`
 *     = origine courante. Ainsi le fallback fonctionne même sans variable
 *     d'environnement, en dev local comme en diagnostic direct sur le port 3001.
 *  4. vérifie que chaque fichier listé existe (échec explicite sinon — c'est le
 *     garde-fou anti-divergence : si le frontend ajoute une dépendance, le script
 *     échoue et force à mettre à jour la liste ASSETS).
 */
const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');
const FRONTEND_DIR = path.join(BACKEND_DIR, '..', 'frontend');
const FALLBACK_DIR = path.join(BACKEND_DIR, 'public-fallback');

const PAGES = ['index.html', 'auth-signin.html'];

// Liste FERMÉE des dépendances du fallback (relatif à frontend/). Si le frontend
// ajoute un <script>/<link>/partiel utilisé par ces 2 pages, ajouter son chemin ici.
const ASSETS = [
  'assets/js/ai-assistant-widget.js',
  'assets/js/backend-config.js', // réécrit ensuite (étape 3), listé ici pour le contrôle d'existence
  'assets/js/config.js',
  'assets/js/layout.js',
  'assets/js/reassort-auth.js',
  'assets/js/shop-picker.js',
  'assets/css/theme-override.css',
  'assets/partials/sidebar.html',
  'assets/partials/topbar.html',
  'assets/volt/css/volt.css',
  'assets/volt/vendor/bootstrap/dist/js/bootstrap.min.js',
  'assets/volt/vendor/@popperjs/core/dist/umd/popper.min.js',
  'assets/volt/vendor/simplebar/dist/simplebar.min.js',
];

function main() {
  const missing = [];
  for (const rel of [...PAGES, ...ASSETS]) {
    if (!fs.existsSync(path.join(FRONTEND_DIR, rel))) missing.push(rel);
  }
  if (missing.length > 0) {
    console.error('[sync-fallback] Fichiers frontend introuvables :');
    missing.forEach((m) => console.error('  - ' + m));
    console.error("[sync-fallback] Mettez à jour les listes PAGES/ASSETS dans backend/scripts/syncFallback.js.");
    process.exit(1);
  }

  fs.rmSync(FALLBACK_DIR, { recursive: true, force: true });
  for (const rel of [...PAGES, ...ASSETS]) {
    const src = path.join(FRONTEND_DIR, rel);
    const dest = path.join(FALLBACK_DIR, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  // backend-config.js du fallback : même origine que la page servie (le backend
  // lui-même), donc pas de CORS et pas besoin de BACKEND_URL. reassort-auth.js
  // utilise window.REASSORT_BACKEND_URL en priorité s'il est défini (ligne 10).
  const backendConfigDest = path.join(FALLBACK_DIR, 'assets/js/backend-config.js');
  fs.writeFileSync(
    backendConfigDest,
    '// Généré par backend/scripts/syncFallback.js : le fallback est servi par le backend\n' +
    '// lui-même, donc l API est sur la même origine — pas de CORS, pas de variable à injecter.\n' +
    'window.REASSORT_BACKEND_URL = window.location.protocol + "//" + window.location.host;\n'
  );

  const sizeKb = Math.round(
    [...PAGES, ...ASSETS].reduce((sum, rel) => sum + fs.statSync(path.join(FALLBACK_DIR, rel)).size, 0) / 1024
  );
  console.log(`[sync-fallback] OK : ${PAGES.length} pages + ${ASSETS.length} assets → backend/public-fallback/ (~${sizeKb} Ko)`);
}

main();
