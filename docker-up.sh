#!/bin/bash
# Build + démarrage des conteneurs, puis affichage automatique du bloc "COMPTE ADMINISTRATEUR"
# (généré par backend/prisma/create-admin.js au démarrage du conteneur backend). En mode
# `docker-compose up -d`, ce bloc part dans les logs du conteneur et n'apparaît jamais dans le
# terminal : ce script va le rechercher pour l'afficher, sans avoir à taper `docker logs` à la main.
#
# Usage : ./docker-up.sh
set -e

echo "🔨 Build et démarrage des conteneurs (docker-compose up -d --build)..."
docker-compose up -d --build

echo ""
echo "⏳ Attente de la création/vérification du compte administrateur..."
BACKEND_CONTAINER=$(docker-compose ps -q backend)

# Le script create-admin.js tourne juste après les migrations, au tout début du conteneur : on
# attend qu'il ait fini d'écrire son bloc avant de le chercher dans les logs (jusqu'à 60s).
FOUND=""
for i in $(seq 1 30); do
  if docker logs "$BACKEND_CONTAINER" 2>&1 | grep -q "COMPTE ADMINISTRATEUR"; then
    FOUND="1"
    break
  fi
  sleep 2
done

echo ""
if [ -n "$FOUND" ]; then
  docker logs "$BACKEND_CONTAINER" 2>&1 | grep -A6 "COMPTE ADMINISTRATEUR PRÊT"
else
  echo "⚠️  Bloc d'identifiants introuvable dans les logs (compte déjà existant depuis un"
  echo "   démarrage précédent, ou backend pas encore prêt). Voir : docker logs $BACKEND_CONTAINER"
fi

echo ""
echo "✅ Conteneurs démarrés. Interface : http://localhost:8080"
