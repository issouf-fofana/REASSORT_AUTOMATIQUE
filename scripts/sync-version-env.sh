#!/usr/bin/env bash
# Met à jour (ou crée) la variable VERSION dans .env à partir du fichier VERSION à la racine —
# docker-compose.yml lit ${VERSION} pour le passer en build-arg au frontend (cf. son propre
# commentaire). docker compose ne peut lire que .env (ou des variables shell déjà exportées),
# jamais un fichier arbitraire comme VERSION directement, d'où cette synchronisation.
#
# Appelé automatiquement par scripts/git-hooks/pre-commit à chaque commit (VERSION change alors) —
# peut aussi être relancé manuellement sans rien committer si .env a été supprimé/désynchronisé.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION_FILE="$REPO_ROOT/VERSION"
ENV_FILE="$REPO_ROOT/.env"

CURRENT_VERSION="$(cat "$VERSION_FILE" | tr -d '[:space:]')"

if [ -f "$ENV_FILE" ] && grep -q '^VERSION=' "$ENV_FILE"; then
  # macOS/BSD sed nécessite un argument après -i (même vide) ; GNU sed accepte -i seul. '' fonctionne
  # sur les deux, contrairement à -i seul (GNU) ou -i '' seul (BSD) pris isolément.
  sed -i'' -e "s/^VERSION=.*/VERSION=${CURRENT_VERSION}/" "$ENV_FILE"
else
  echo "VERSION=${CURRENT_VERSION}" >> "$ENV_FILE"
fi
