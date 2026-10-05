import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Servi par nginx sous /sales-analysis-app/ (voir frontend/nginx.conf), même patron que
// react-app-order-anomalies/ — projet Vite séparé plutôt que multi-page.
export default defineConfig({
  base: '/sales-analysis-app/',
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
})
