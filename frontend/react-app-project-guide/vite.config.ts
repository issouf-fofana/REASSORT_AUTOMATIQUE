import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))

// Servi par nginx sous /project-guide-app/ (voir frontend/nginx.conf), même patron que les autres
// pages migrées — projet Vite séparé pour ne jamais risquer de casser le build des autres pages.
// Tailwind ajouté uniquement pour la barre d'onglets "pilule" animée (NotchTabBar, demande du
// 25/09/2026 de généraliser le style de Paramètres) — scope limité à .reassort-tabs-root (cf.
// src/index.css), jamais appliqué au reste de la page qui reste en Bootstrap/Volt.
export default defineConfig({
  base: '/project-guide-app/',
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
