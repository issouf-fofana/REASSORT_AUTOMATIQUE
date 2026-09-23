import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Servi par nginx sous /sales-history-app/ (voir frontend/nginx.conf), même patron que
// react-app/ et react-app-dashboard/ — projet Vite séparé pour ne jamais risquer de casser le
// build des autres pages déjà migrées.
export default defineConfig({
  base: '/sales-history-app/',
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
})
