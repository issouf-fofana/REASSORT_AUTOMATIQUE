# Copier le thème de ce projet vers un autre projet

Ce document explique comment réutiliser **exactement le même thème visuel** (couleurs, mode clair/sombre, typographie, arrondis) que `erp-frontend` dans un autre projet React + Tailwind, et comment lancer les deux projets **en même temps sans conflit de ports**.

## 1. Stack concernée

Le thème de ce projet repose sur 3 fichiers, tous dans `erp-frontend/` :

| Fichier | Rôle |
|---|---|
| `src/index.css` | Tokens CSS (`--color-*`) en mode clair (`:root`) et sombre (`.dark`), imports Google Fonts, transitions |
| `tailwind.config.js` | Mappe les tokens CSS vers des classes Tailwind (`bg-surface`, `text-on-surface`, `border-outline`, etc.) |
| `src/context/ThemeContext.jsx` | `ThemeProvider` React : bascule `.dark` sur `<html>`, persiste le choix dans `localStorage` |

Le projet utilise Tailwind CSS 3, `darkMode: 'class'`, et des polices Google Fonts (**Inter**, **JetBrains Mono**) + Material Symbols.

## 2. Fichiers à copier tels quels

Dans le projet cible :

1. **`src/index.css`** → copier intégralement le bloc de tokens (`:root { ... }` et `.dark { ... }`), les imports `@import url(...)` de Google Fonts, et le bloc de transition `*, *::before, *::after { transition-property: ... }`.
   - Si le projet cible n'utilise pas encore Tailwind, garder aussi les 3 lignes `@tailwind base/components/utilities;`.
   - Adapter uniquement les imports `@import "tw-animate-css"`, `@import "shadcn/tailwind.css"`, `@import "@fontsource-variable/geist"` si ces paquets ne sont pas installés côté cible (sinon `npm install tw-animate-css @fontsource-variable/geist` + shadcn).

2. **`tailwind.config.js`** → copier le bloc `theme.extend.colors` (tous les `'xxx': 'var(--color-xxx)'`), `borderRadius`, `spacing`, `fontFamily`, `fontSize`. Fusionner avec la config existante du projet cible plutôt que l'écraser si elle a déjà du contenu.

3. **`src/context/ThemeContext.jsx`** → copier le fichier tel quel dans `src/context/` du projet cible. Envelopper l'app avec `<ThemeProvider>` (dans `main.jsx` ou `App.jsx`), puis utiliser `useTheme()` où le toggle clair/sombre est nécessaire.

## 3. Dépendances à installer côté projet cible

```bash
npm install tailwindcss@^3.4.15 autoprefixer postcss
# si utilisés dans index.css :
npm install tw-animate-css @fontsource-variable/geist
```

Vérifier que `tailwind.config.js` du projet cible a bien `darkMode: 'class'` et un `content` qui couvre ses propres fichiers (`./index.html`, `./src/**/*.{js,ts,jsx,tsx}`).

## 4. Utilisation dans les composants du projet cible

Ne jamais coder une couleur en dur. Utiliser les classes Tailwind générées à partir des tokens :

```jsx
<div className="bg-surface text-on-surface border border-outline rounded-lg">
  <button className="bg-primary text-on-primary">Valider</button>
</div>
```

Le mode sombre s'active automatiquement dès que `<html class="dark">` est posé — c'est `ThemeContext.jsx` qui s'en charge.

## 5. Lancer les deux projets en parallèle sans se couper le port

Ce projet (`erp-ia-prosuma-fofana`) utilise :

- **Backend** : port `4000` (`erp-backend/.env.example` → `PORT=4000`)
- **Frontend** : port `5173` (Vite, proxy `/api` et `/socket.io` vers `http://localhost:4000`)

Quand tu lances le **nouveau** projet, change ses ports pour ne pas entrer en collision avec ceux-ci :

### Backend (nouveau projet)

Dans son `.env` :
```
PORT=4001
```
(ou tout autre port libre, différent de `4000`)

### Frontend (nouveau projet, Vite)

Dans son `vite.config.js` :
```js
server: {
  host: true,
  port: 5174, // au lieu de 5173, déjà pris par ce projet
  proxy: {
    '/api': { target: 'http://localhost:4001', changeOrigin: true }, // pointe vers le nouveau backend
    '/socket.io': { target: 'http://localhost:4001', changeOrigin: true, ws: true }
  }
}
```

Et adapter son `.env` frontend :
```
VITE_API_URL=http://localhost:4001/api
```

### Vérifier qu'un port est libre avant de lancer

```bash
lsof -i :5174 -i :4001
```
Si la commande ne retourne rien, les ports sont libres.

### Lancer les deux projets simultanément

```bash
# Terminal 1 — projet actuel (déjà en cours, ne pas relancer si actif)
cd erp-ia-prosuma-fofana && ./start.sh

# Terminal 2 — nouveau projet
cd /chemin/vers/nouveau-projet
PORT=4001 npm run dev --prefix backend   # ou équivalent
npm run dev --prefix frontend -- --port 5174
```

## 6. Checklist rapide

- [ ] Tokens CSS copiés dans `index.css` du nouveau projet (clair + sombre)
- [ ] `tailwind.config.js` fusionné (colors, radius, spacing, fonts)
- [ ] `ThemeContext.jsx` copié et `ThemeProvider` branché
- [ ] Polices Google Fonts chargées (Inter, JetBrains Mono)
- [ ] Port backend du nouveau projet ≠ `4000`
- [ ] Port frontend du nouveau projet ≠ `5173`
- [ ] `VITE_API_URL` et proxy Vite du nouveau projet pointent vers son propre backend
