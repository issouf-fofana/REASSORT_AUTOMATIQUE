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

# Stage de build de la page Assistant IA migrée vers React (cinquième page migrée, projet Vite
# séparé même raison que ci-dessus).
FROM node:20-alpine AS ai-assistant-builder
WORKDIR /app
COPY react-app-ai-assistant/package*.json ./
RUN npm ci
COPY react-app-ai-assistant/ .
RUN npm run build

# Stage de build de la page Mon accès (Guide IA) migrée vers React (sixième page migrée, projet
# Vite séparé même raison que ci-dessus).
FROM node:20-alpine AS ai-guide-builder
WORKDIR /app
COPY react-app-ai-guide/package*.json ./
RUN npm ci
COPY react-app-ai-guide/ .
RUN npm run build

# Stage de build de la page Qualité & IA migrée vers React (septième page migrée — fusion de 5
# onglets, projet Vite séparé même raison que ci-dessus).
FROM node:20-alpine AS ai-quality-builder
WORKDIR /app
COPY react-app-ai-quality/package*.json ./
RUN npm ci
COPY react-app-ai-quality/ .
RUN npm run build

# Stage de build de la page Utilisateurs migrée vers React (huitième page migrée, projet Vite
# séparé même raison que ci-dessus).
FROM node:20-alpine AS users-builder
WORKDIR /app
COPY react-app-users/package*.json ./
RUN npm ci
COPY react-app-users/ .
RUN npm run build

# Stage de build de la page Guide du projet migrée vers React (neuvième page migrée, projet Vite
# séparé même raison que ci-dessus).
FROM node:20-alpine AS project-guide-builder
WORKDIR /app
COPY react-app-project-guide/package*.json ./
RUN npm ci
COPY react-app-project-guide/ .
RUN npm run build

# Stage de build de la page Historique des commandes migrée vers React (dixième page migrée,
# projet Vite séparé même raison que ci-dessus).
FROM node:20-alpine AS purchase-list-builder
WORKDIR /app
COPY react-app-purchase-list/package*.json ./
RUN npm ci
COPY react-app-purchase-list/ .
RUN npm run build

# Stage de build de Proposition de commande migrée vers React (bascule complète le 24/09/2026 :
# génération, envoi RPOS, historique de la semaine, analytics — servie sous /purchase-order,
# purchase-order.html devenu purchase-order.old.html).
FROM node:20-alpine AS purchase-order-builder
WORKDIR /app
COPY react-app-purchase-order/package*.json ./
RUN npm ci
COPY react-app-purchase-order/ .
RUN npm run build

# Stage de build de Tableau de bord migré vers React (24/09/2026, remplace index.html à la racine
# du site — projet Vite séparé même raison que ci-dessus).
FROM node:20-alpine AS tableau-de-bord-builder
WORKDIR /app
COPY react-app-tableau-de-bord/package*.json ./
RUN npm ci
COPY react-app-tableau-de-bord/ .
RUN npm run build

# Stage de build de Mémoire du modèle migrée vers React (24/09/2026, projet Vite séparé même raison
# que ci-dessus).
FROM node:20-alpine AS ai-mastery-builder
WORKDIR /app
COPY react-app-ai-mastery/package*.json ./
RUN npm ci
COPY react-app-ai-mastery/ .
RUN npm run build

# Stage de build de Anomalies de commande migrée vers React (24/09/2026, dernière page du site
# encore en HTML classique avant celle-ci — projet Vite séparé même raison que ci-dessus).
FROM node:20-alpine AS order-anomalies-builder
WORKDIR /app
COPY react-app-order-anomalies/package*.json ./
RUN npm ci
COPY react-app-order-anomalies/ .
RUN npm run build

FROM node:20-alpine AS auth-signin-builder
WORKDIR /app
COPY react-app-auth-signin/package*.json ./
RUN npm ci
COPY react-app-auth-signin/ .
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

# Résultat du build React (Assistant IA), servi sous /ai-assistant-app/ par une règle nginx dédiée
# (voir nginx.conf).
COPY --from=ai-assistant-builder /app/dist /usr/share/nginx/html/ai-assistant-app

# Résultat du build React (Mon accès / Guide IA), servi sous /ai-guide-app/ par une règle nginx
# dédiée (voir nginx.conf).
COPY --from=ai-guide-builder /app/dist /usr/share/nginx/html/ai-guide-app

# Résultat du build React (Qualité & IA), servi sous /ai-quality-app/ par une règle nginx dédiée
# (voir nginx.conf).
COPY --from=ai-quality-builder /app/dist /usr/share/nginx/html/ai-quality-app

# Résultat du build React (Utilisateurs), servi sous /users-app/ par une règle nginx dédiée
# (voir nginx.conf).
COPY --from=users-builder /app/dist /usr/share/nginx/html/users-app

# Résultat du build React (Guide du projet), servi sous /project-guide-app/ par une règle nginx
# dédiée (voir nginx.conf).
COPY --from=project-guide-builder /app/dist /usr/share/nginx/html/project-guide-app

# Résultat du build React (Historique des commandes), servi sous /purchase-list-app/ par une règle
# nginx dédiée (voir nginx.conf).
COPY --from=purchase-list-builder /app/dist /usr/share/nginx/html/purchase-list-app

# Résultat du build React (Proposition de commande), servi sous /purchase-order-app/ par une règle
# nginx dédiée (voir nginx.conf).
COPY --from=purchase-order-builder /app/dist /usr/share/nginx/html/purchase-order-app

# Résultat du build React (Tableau de bord), servi sous /tableau-de-bord-app/ par une règle nginx dédiée
# (voir nginx.conf) — remplace index.html à la racine du site (/).
COPY --from=tableau-de-bord-builder /app/dist /usr/share/nginx/html/tableau-de-bord-app

# Résultat du build React (Mémoire du modèle), servi sous /ai-mastery-app/ par une règle nginx
# dédiée (voir nginx.conf).
COPY --from=ai-mastery-builder /app/dist /usr/share/nginx/html/ai-mastery-app

# Résultat du build React (Anomalies de commande), servi sous /order-anomalies-app/ par une règle
# nginx dédiée (voir nginx.conf) — dernière page du site migrée vers React.
COPY --from=order-anomalies-builder /app/dist /usr/share/nginx/html/order-anomalies-app
COPY --from=auth-signin-builder /app/dist /usr/share/nginx/html/auth-signin-app

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
