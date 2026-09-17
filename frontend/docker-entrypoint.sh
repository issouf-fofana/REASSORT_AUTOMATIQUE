#!/bin/sh
# Génère assets/js/backend-config.js à partir de BACKEND_URL avant de démarrer nginx, pour que le
# frontend sache où joindre l'API sans reconstruire l'image à chaque changement de domaine
# (Dockploy attribue un domaine différent au backend, jamais connu au moment du build de l'image).
set -e

CONFIG_FILE=/usr/share/nginx/html/assets/js/backend-config.js

# Nom du service backend dans CE réseau Docker Compose ("app" par défaut, cf. dokploy.yaml) —
# à surcharger avec INTERNAL_BACKEND_HOST=backend en dev local (docker-compose.yml, service nommé
# différemment). Substitué dans nginx.conf avant de démarrer nginx : sans ça, un nom codé en dur
# qui ne correspond à aucun service du réseau fait planter nginx au démarrage ("host not found in
# upstream"), pas juste échouer la requête /api-backend/.
INTERNAL_BACKEND_HOST="${INTERNAL_BACKEND_HOST:-app}"
# host.docker.internal n'est pas connu du resolver DNS Docker (127.0.0.11) utilisé par nginx pour
# résoudre la cible du proxy à chaque requête — seulement de /etc/hosts du conteneur (mécanisme
# extra_hosts, différent). On le résout donc ici, une fois, vers son IP réelle avant de l'injecter
# dans nginx.conf, plutôt que de laisser nginx échouer sur ce nom à chaque appel /api-backend/.
if [ "$INTERNAL_BACKEND_HOST" = "host.docker.internal" ]; then
  RESOLVED_IP=$(getent hosts host.docker.internal | awk '{print $1}' | head -1)
  if [ -n "$RESOLVED_IP" ]; then
    INTERNAL_BACKEND_HOST="$RESOLVED_IP"
  fi
fi
sed -i "s/__INTERNAL_BACKEND_HOST__/${INTERNAL_BACKEND_HOST}/g" /etc/nginx/conf.d/default.conf
echo "[docker-entrypoint] Proxy /api-backend/ -> ${INTERNAL_BACKEND_HOST}:3001"

if [ -n "$BACKEND_URL" ]; then
  BACKEND_URL_TRIMMED=$(echo "$BACKEND_URL" | sed 's:/*$::')
  echo "window.REASSORT_BACKEND_URL = \"${BACKEND_URL_TRIMMED}\";" > "$CONFIG_FILE"
  echo "[docker-entrypoint] BACKEND_URL configuré : $BACKEND_URL_TRIMMED"
else
  echo "window.REASSORT_BACKEND_URL = null;" > "$CONFIG_FILE"
  echo "[docker-entrypoint] BACKEND_URL non défini : fallback sur le port :3001 du même hostname (dev local uniquement)."
fi

exec "$@"
