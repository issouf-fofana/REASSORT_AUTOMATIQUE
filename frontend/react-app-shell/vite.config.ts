import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))

// Socle de la fusion progressive des 20 apps React en une seule SPA (cf. plan de migration,
// 12/10/2026) — base dédiée '/app-assets/' pour ne JAMAIS collisionner avec '/assets/' (scripts
// vanilla partagés : reassort-auth.js, layout-collapsible.js, etc., toujours servis à la racine
// pendant toute la durée de la coexistence avec les 19 apps non encore migrées).
export default defineConfig({
  base: '/app-assets/',
  plugins: [react()],
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  build: {
    outDir: 'dist',
  },
})
