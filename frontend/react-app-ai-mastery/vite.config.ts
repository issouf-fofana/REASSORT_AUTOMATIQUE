import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Servi par nginx sous /ai-mastery-app/ (voir frontend/nginx.conf), même patron que
// react-app/ (page Paramètres) — projet Vite séparé plutôt que multi-page pour ne jamais risquer
// de casser le build de Paramètres en modifiant une config partagée.
export default defineConfig({
  base: '/ai-mastery-app/',
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
})
