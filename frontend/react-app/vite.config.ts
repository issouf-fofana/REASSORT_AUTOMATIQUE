import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Servi par nginx sous /settings-app/ (voir frontend/nginx.conf) — le bundle référence donc ses
// propres assets avec ce préfixe, jamais depuis la racine du site (qui reste les pages HTML
// classiques pour toutes les pages non encore migrées).
export default defineConfig({
  base: '/settings-app/',
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
})
