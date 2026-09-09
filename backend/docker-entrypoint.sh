#!/bin/sh
# Prépare la base de données et le compte d'accès avant de démarrer le serveur, pour qu'un premier
# déploiement Dockploy soit utilisable immédiatement sans étape manuelle dans la console/SSH.
set -e

# --accept-data-loss : nécessaire pour un démarrage non-interactif (sinon `db push` attend une
# confirmation au clavier et bloque indéfiniment le conteneur). Ce projet n'a pas de migrations
# Prisma formelles (cf. absence de prisma/migrations/) : tout changement de schéma passe par ce
# `db push` — un changement de type de colonne incompatible avec les données existantes serait donc
# appliqué sans confirmation manuelle. Acceptable ici car chaque évolution de schéma de ce projet a
# été additive jusqu'à présent (nouvelles colonnes/tables) ; à surveiller si un futur changement
# devient réellement destructif (suppression de colonne encore utilisée, par ex.).
echo "[docker-entrypoint] Synchronisation du schéma de base de données (prisma db push)..."
npx prisma db push --skip-generate --accept-data-loss

echo "[docker-entrypoint] Vérification du compte administrateur..."
node prisma/create-admin.js

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  🚀 REASSORT AUTOMATIQUE — ACCÈS"
echo "═══════════════════════════════════════════════════════"
echo "  API backend : ${PUBLIC_URL:-http://<votre-domaine-backend>}"
if [ -n "$FRONTEND_URL" ]; then
  echo "  Interface   : ${FRONTEND_URL}"
fi
echo "  (identifiants du compte administrateur affichés ci-dessus"
echo "   uniquement lors de sa toute première création)"
echo "═══════════════════════════════════════════════════════"
echo ""

exec "$@"
