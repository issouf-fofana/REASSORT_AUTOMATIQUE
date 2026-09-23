import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Servi par nginx sous /ai-guide-app/ (voir frontend/nginx.conf), même patron que les autres pages
// migrées — projet Vite séparé pour ne jamais risquer de casser le build des autres pages.
export default defineConfig({
  base: '/ai-guide-app/',
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
})
