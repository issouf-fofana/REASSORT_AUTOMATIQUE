#!/bin/sh
# Génère assets/js/backend-config.js à partir de BACKEND_URL avant de démarrer nginx, pour que le
# frontend sache où joindre l'API sans reconstruire l'image à chaque changement de domaine
# (Dockploy attribue un domaine différent au backend, jamais connu au moment du build de l'image).
set -e

CONFIG_FILE=/usr/share/nginx/html/assets/js/backend-config.js

if [ -n "$BACKEND_URL" ]; then
  BACKEND_URL_TRIMMED=$(echo "$BACKEND_URL" | sed 's:/*$::')
  echo "window.REASSORT_BACKEND_URL = \"${BACKEND_URL_TRIMMED}\";" > "$CONFIG_FILE"
  echo "[docker-entrypoint] BACKEND_URL configuré : $BACKEND_URL_TRIMMED"
else
  echo "window.REASSORT_BACKEND_URL = null;" > "$CONFIG_FILE"
  echo "[docker-entrypoint] BACKEND_URL non défini : fallback sur le port :3001 du même hostname (dev local uniquement)."
fi

exec "$@"
