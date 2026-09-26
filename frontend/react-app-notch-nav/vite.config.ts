import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

const srcDir = fileURLToPath(new URL('./src', import.meta.url))

// Bundle unique de la barre de navigation "notch", injecté comme script partagé dans les 14 pages
// du site (remplace assets/partials/topbar.html + sidebar.html) — jamais un projet Vite par page
// comme le reste du site : un seul composant React ici, monté depuis un point d'entrée non-module
// (IIFE) pour rester chargeable en <script> classique, sans avoir à convertir les 14 pages en
// modules ES ni à dupliquer Tailwind/shadcn/framer-motion dans chacune d'elles.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // React (et certaines de ses dépendances) lisent process.env.NODE_ENV pour basculer entre
  // vérifications de dev et code de production — présent nativement sous Node/un bundler ES, mais
  // `process` n'existe pas du tout dans un navigateur exécutant un bundle IIFE autonome comme
  // celui-ci (constaté : "Uncaught ReferenceError: process is not defined", montage React
  // silencieusement avorté, #notch-nav-slot restait vide). Remplacé en dur au build, comme le fait
  // vite build par défaut pour un mode 'esm'/'app' classique mais pas automatiquement pour lib/iife.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  build: {
    outDir: 'dist',
    lib: {
      entry: `${srcDir}/mount.tsx`,
      name: 'ReassortNotchNav',
      formats: ['iife'],
      fileName: () => 'notch-nav.js',
    },
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        assetFileNames: 'notch-nav.[ext]',
      },
    },
  },
})
