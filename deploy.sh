#!/bin/bash
# Script de déploiement Git : vérification + add + commit + confirmation + push vers GitHub.
# Usage : ./deploy.sh "message de commit"
# Si aucun message n'est fourni, un message par défaut horodaté est utilisé.

set -e  # arrête le script à la première erreur

MESSAGE="${1:-Mise à jour du $(date '+%d/%m/%Y à %H:%M')}"

echo "📋 Statut actuel du dépôt :"
git status --short

# Vérifie s'il y a quoi que ce soit à committer (modifié, ajouté, non suivi) avant d'aller plus
# loin — pas de commit vide.
if [ -z "$(git status --porcelain)" ]; then
  echo "✅ Rien à valider, le dépôt est déjà à jour."
  exit 0
fi

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

echo ""
echo "✅ Commit créé localement :"
git log --oneline -1

echo ""
echo "🌿 Branches disponibles :"
git branch -a

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo ""
read -p "Sur quelle branche pousser ? [$CURRENT_BRANCH] " TARGET_BRANCH
TARGET_BRANCH="${TARGET_BRANCH:-$CURRENT_BRANCH}"

echo ""
read -p "Confirmer le push vers origin/$TARGET_BRANCH ? (o/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Oo]$ ]]; then
  echo "❌ Push annulé. Le commit reste en local, à pousser plus tard avec :"
  echo "   git push origin $TARGET_BRANCH"
  exit 1
fi

echo "🚀 Envoi vers GitHub (origin/$TARGET_BRANCH)..."
git push origin "HEAD:$TARGET_BRANCH"

echo "✅ Déploiement terminé."
