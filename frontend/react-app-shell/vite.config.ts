import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))

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
  build: {
    outDir: 'dist',
  },
})
