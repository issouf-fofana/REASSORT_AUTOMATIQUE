# Stage de build de la page Paramètres migrée vers React (23/09/2026, migration progressive
# page par page — voir /home/youssef/.claude/plans/compressed-roaming-orbit.md). Séparé du stage
# nginx final : node_modules et les sources TypeScript ne doivent jamais atterrir dans l'image
# servie publiquement, seul le résultat du build (react-app/dist) en sort (COPY --from= plus bas).
FROM node:20-alpine AS react-builder
WORKDIR /app
COPY react-app/package*.json ./
RUN npm ci
COPY react-app/ .
RUN npm run build

# Stage de build du Dashboard admin migré vers React (page pilote suivante après Paramètres) —
# projet Vite séparé (frontend/react-app-dashboard/) plutôt que multi-page dans react-app/, pour ne
# jamais risquer de casser le build de Paramètres en modifiant une config partagée.
FROM node:20-alpine AS dashboard-builder
WORKDIR /app
COPY react-app-dashboard/package*.json ./
RUN npm ci
COPY react-app-dashboard/ .
RUN npm run build

# Stage de build de la page Ventes synchronisées migrée vers React (troisième page migrée, projet
# Vite séparé même raison que ci-dessus).
FROM node:20-alpine AS sales-history-builder
WORKDIR /app
COPY react-app-sales-history/package*.json ./
RUN npm ci
COPY react-app-sales-history/ .
RUN npm run build

# Stage de build de la page IA & Prédictions migrée vers React (quatrième page migrée, projet Vite
# séparé même raison que ci-dessus).
FROM node:20-alpine AS ai-predictions-builder
WORKDIR /app
COPY react-app-ai-predictions/package*.json ./
RUN npm ci
COPY react-app-ai-predictions/ .
RUN npm run build

FROM nginx:alpine

# Servi séparément de /usr/share/nginx/html (le COPY . ci-dessous) : sinon nginx.conf finirait
# lui-même exposé publiquement comme un fichier statique quelconque du site.
COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY . /usr/share/nginx/html
# nginx.conf n'a pas sa place parmi les fichiers servis (copié une seconde fois par le COPY .
# ci-dessus avant d'avoir pu l'exclure autrement, faute de .dockerignore dans ce projet) : retiré
# explicitement du dossier public plutôt que de laisser la config nginx elle-même téléchargeable.
RUN rm -f /usr/share/nginx/html/nginx.conf

# Résultat du build React (page Paramètres), servi sous /settings-app/ par une règle nginx dédiée
# (voir nginx.conf) — jamais mélangé avec les pages HTML classiques du COPY . ci-dessus.
COPY --from=react-builder /app/dist /usr/share/nginx/html/settings-app

# Résultat du build React (Dashboard admin), servi sous /dashboard-app/ par une règle nginx dédiée
# (voir nginx.conf).
COPY --from=dashboard-builder /app/dist /usr/share/nginx/html/dashboard-app

# Résultat du build React (Ventes synchronisées), servi sous /sales-history-app/ par une règle
# nginx dédiée (voir nginx.conf).
COPY --from=sales-history-builder /app/dist /usr/share/nginx/html/sales-history-app

# Résultat du build React (IA & Prédictions), servi sous /ai-predictions-app/ par une règle nginx
# dédiée (voir nginx.conf).
COPY --from=ai-predictions-builder /app/dist /usr/share/nginx/html/ai-predictions-app

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
