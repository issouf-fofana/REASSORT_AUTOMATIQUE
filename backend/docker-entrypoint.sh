#!/bin/sh
# Prépare la base de données et le compte d'accès avant de démarrer le serveur, pour qu'un premier
# déploiement Dockploy soit utilisable immédiatement sans étape manuelle dans la console/SSH.
set -e

# Le schéma est versionné dans prisma/migrations/ (baseline 0000_baseline + évolutions).
# Le démarrage applique ces migrations via `prisma migrate deploy` (non-interactif,
# jamais destructif sans migration explicite) avant de vérifier le compte admin.
echo "[docker-entrypoint] Application des migrations de base de données (prisma migrate deploy)..."
npx prisma migrate deploy

echo "[docker-entrypoint] Vérification du compte administrateur..."
node prisma/create-admin.js

# Les rattrapages de données (dates de livraison week-end, secteur/rayon "Sans secteur") tournent
# désormais APRÈS le démarrage du serveur, en arrière-plan (cf. server.js) — jamais ici, avant
# `exec "$@"`. CORRIGÉ le 18/10/2026 suite à un vrai incident : les lancer ici, synchrones et
# bloquants avant le démarrage du serveur HTTP, a rendu le service injoignable en prod le temps de
# leur exécution (le job secteur/rayon fait de vrais appels RPOS un par un, potentiellement des
# dizaines de minutes avec plusieurs milliers d'épisodes sur le réseau — Dokploy/le healthcheck
# voyait alors le port 3001 refuser toute connexion et considérait le service mort). Voir
# server.js pour le déclenchement différé.

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  🚀 REASSORT AUTOMATIQUE — ACCÈS"
echo "═══════════════════════════════════════════════════════"
echo "  API backend : ${PUBLIC_URL:-http://<votre-domaine-backend>}"
if [ -n "$FRONTEND_URL" ]; then
  echo "  Interface   : ${FRONTEND_URL}"
fi
echo "  (identifiants du compte administrateur affichés ci-dessus)"
# Mot de passe de la base de données (23/09/2026, demande explicite : "on doit voir... le password
# de la base de donner... au build") — extrait directement de DATABASE_URL plutôt que dupliqué dans
# une variable séparée, pour ne jamais afficher une valeur qui pourrait diverger de celle réellement
# utilisée par la connexion Prisma. sed capture ce qui suit ":" (après l'utilisateur) et précède "@".
DB_PASSWORD_DISPLAY=$(echo "$DATABASE_URL" | sed -n 's#.*://[^:]*:\([^@]*\)@.*#\1#p')
if [ -n "$DB_PASSWORD_DISPLAY" ]; then
  echo "  Mot de passe base de données (PostgreSQL) : ${DB_PASSWORD_DISPLAY}"
fi
echo "═══════════════════════════════════════════════════════"
echo ""

exec "$@"
