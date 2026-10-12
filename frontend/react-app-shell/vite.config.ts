import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))

// Lu depuis VERSION à la racine du dépôt (/home/youssef/Documents/REASSORT_AUTO/VERSION, pas dans
// ce sous-dossier) — incrémenté automatiquement à chaque commit par scripts/git-hooks/pre-commit
// (demande explicite du 13/10/2026 : "V1.0.0, V1.0.1... à chaque push"). Lu ici au moment du build,
// jamais au runtime navigateur (pas de fetch réseau juste pour un numéro de version) — injecté en
// constante statique via `define`, remplacée littéralement dans le bundle par esbuild/Rollup.
//
// En conteneur Docker, ce fichier n'existe pas (le contexte de build de ce service est `./frontend`,
// VERSION vit un niveau au-dessus, hors de ce contexte) — Dockerfile (stage shell-builder) passe
// alors la version via la variable d'env VITE_APP_VERSION (build-arg APP_VERSION), prioritaire ici
// sur la lecture du fichier local. Fallback '0.0.0-dev' si ni l'un ni l'autre n'est disponible
// (ex: build exécuté hors du dépôt Git complet), jamais une erreur de build pour un simple numéro
// d'affichage.
function readAppVersion(): string {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION
  try {
    return readFileSync(new URL('../../VERSION', import.meta.url), 'utf-8').trim()
  } catch {
    return '0.0.0-dev'
  }
}

// Socle de la fusion progressive des 20 apps React en une seule SPA (cf. plan de migration,
// 12/10/2026) — base dédiée '/app-assets/' pour ne JAMAIS collisionner avec '/assets/' (scripts
// vanilla partagés : reassort-auth.js, layout-collapsible.js, etc., toujours servis à la racine
// pendant toute la durée de la coexistence avec les 19 apps non encore migrées).
// Tailwind ajouté le 12/10/2026 (migration de /project-guide, qui réutilise NotchTabBar — barre
// d'onglets "pilule" animée partagée avec Paramètres/Qualité IA/Connexion) — SCOPÉ explicitement à
// .reassort-tabs-root (cf. src/index.css), jamais appliqué globalement : son préflight casserait
// sinon le style Bootstrap/Volt de TOUTES les pages du shell, pas seulement celle qui en a besoin.
export default defineConfig({
  base: '/app-assets/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(readAppVersion()),
  },
  build: {
    outDir: 'dist',
  },
})
