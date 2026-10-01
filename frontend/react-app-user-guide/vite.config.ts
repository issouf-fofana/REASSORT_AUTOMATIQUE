import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))

// Servi par nginx sous /user-guide-app/ (voir frontend/nginx.conf), même patron que les autres
// pages migrées — projet Vite séparé pour ne jamais risquer de casser le build des autres pages.
export default defineConfig({
  base: '/user-guide-app/',
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
