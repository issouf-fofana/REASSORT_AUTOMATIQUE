#!/bin/bash
# Script de déploiement Git : add + commit + push vers GitHub.
# Usage : ./deploy.sh "message de commit"
# Si aucun message n'est fourni, un message par défaut horodaté est utilisé.

set -e  # arrête le script à la première erreur

MESSAGE="${1:-Mise à jour du $(date '+%d/%m/%Y à %H:%M')}"

echo "📋 Statut actuel du dépôt :"
git status --short

echo ""
read -p "Continuer avec l'ajout de TOUS ces fichiers ? (o/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Oo]$ ]]; then
  echo "❌ Annulé."
  exit 1
fi

echo "➕ Ajout des fichiers..."
git add -A

echo "📝 Création du commit : \"$MESSAGE\""
git commit -m "$MESSAGE"

echo "🚀 Envoi vers GitHub (origin/master)..."
git push origin master

echo "✅ Déploiement terminé."
