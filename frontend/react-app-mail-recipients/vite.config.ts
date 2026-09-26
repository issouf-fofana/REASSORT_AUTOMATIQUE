import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Servi par nginx sous /mail-recipients-app/ (voir frontend/nginx.conf), même patron que
// react-app/ (page Paramètres) — projet Vite séparé plutôt que multi-page pour ne jamais risquer
// de casser le build d'une autre page en modifiant une config partagée.
export default defineConfig({
  base: '/mail-recipients-app/',
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
})
