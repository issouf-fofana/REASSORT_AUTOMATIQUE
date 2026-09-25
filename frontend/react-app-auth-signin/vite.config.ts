import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Servi par nginx sous /auth-signin-app/ (voir frontend/nginx.conf), même patron que les autres
// pages migrées — remplace auth-signin.html (renommé auth-signin.old.html, conservé pour rollback).
// Page 100% autonome (pas de sidebar/topbar Bootstrap à préserver, contrairement aux autres pages) :
// Tailwind chargé globalement sans scope particulier, aucun risque de fuite puisque cette page ne
// partage aucun DOM avec le thème Volt/Bootstrap du reste du site.
export default defineConfig({
  base: '/auth-signin-app/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
  },
})
