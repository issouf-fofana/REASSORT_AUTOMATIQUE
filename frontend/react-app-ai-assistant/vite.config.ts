import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))

// Servi par nginx sous /ai-assistant-app/ (voir frontend/nginx.conf), même patron que les autres
// pages migrées — projet Vite séparé pour ne jamais risquer de casser le build des autres pages.
// Tailwind ajouté uniquement pour AIChatInput.tsx (composant 21st.dev demandé par l'utilisateur,
// 24/09/2026) — scope limité à .reassort-ai-input-root (cf. src/index.css), jamais appliqué au
// reste de la page qui reste en Bootstrap/Volt comme les 13 autres projets React du site.
export default defineConfig({
  base: '/ai-assistant-app/',
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
