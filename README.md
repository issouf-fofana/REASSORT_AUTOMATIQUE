# 📦 Réassort automatique intelligent — Prosuma

Système intelligent de proposition de commandes de réassort pour les magasins Prosuma, intégré à
l'ERP/POS RPOS. Analyse les ventes historiques (classement Pareto 80/20), calcule les quantités à
commander (stock, colisage, saisonnalité, prévision par lissage exponentiel ou par IA), et permet
de valider puis d'envoyer les commandes directement à RPOS, rayon par rayon.

## 🚀 Fonctionnalités principales

- ✅ Génération automatique de propositions de commande (nocturne + à la demande)
- ✅ Navigation par secteur → rayon → article, alignée sur la hiérarchie RPOS réelle
- ✅ Calcul de quantité tenant compte du stock, du colisage fournisseur et des commandes déjà en cours
- ✅ Prévision de vente par lissage exponentiel, avec option d'analyse par IA (Gemini/OpenAI/Anthropic)
- ✅ Synchronisation locale des ventes (jobs planifiés) pour ne plus dépendre de RPOS à chaque consultation
- ✅ Récupération d'historique par tranches avec pause/reprise/annulation
- ✅ Import de fichiers CSV d'export de ventes, avec bascule automatique sur l'API RPOS si absent
- ✅ Gestion multi-magasins / multi-serveurs RPOS (18 serveurs, 52+ magasins)
- ✅ Rôles ADMIN / SUPERVISOR / STORE avec périmètre de magasins supervisés

## 🛠️ Stack technique

- **Backend** : Node.js + Express, jobs planifiés via `node-cron`
- **Base de données** : PostgreSQL, ORM Prisma
- **Frontend** : HTML5 + Bootstrap 5 (template Larkon), JavaScript natif, graphiques ApexCharts
- **Intégration** : API RPOS (Prosuma), API LLM (Gemini/OpenAI/Anthropic) pour l'analyse IA optionnelle
- **Déploiement** : Docker Compose

Détail complet langage par langage, fichier par fichier : voir **[TECH_STACK.md](TECH_STACK.md)**.

## 🧭 Montée en autonomie IA — suivi d'avancement

Plan complet en 14 étapes défini dans **[CAHIER_DES_CHARGES.md](CAHIER_DES_CHARGES.md)** (§71),
vers un système de réassort qui observe, prédit, recommande, puis progressivement automatise sous
contrôle. Chaque étape est implémentée par-dessus l'existant, sans le réécrire.

- ✅ **Étape 1 — Weekly Replenishment Plan** (§11) : chaque `Proposal` générée est désormais
  rattachée à un `WeeklyReplenishmentPlan` représentant sa semaine cible (ex: génération basée sur
  l'analyse des ventes du 1 → 7 septembre → plan pour la semaine du 8 → 14 septembre). Le plan
  persiste au-delà d'une seule génération : une régénération pour la même semaine s'y rattache
  comme révision au lieu de créer un plan séparé. Aucun changement de comportement visible côté
  calcul, validation ou envoi RPOS à cette étape — uniquement la base de données nécessaire aux
  étapes suivantes (révisions explicites, réajustement quotidien). Voir
  `backend/src/services/weeklyPlanService.js` et le modèle `WeeklyReplenishmentPlan`.
- ✅ **Étape 2 — Historique des révisions de proposition** (§12-13) : `getWeeklyPlanHistory()`
  reconstruit, à partir des `Proposal` déjà rattachées à un plan (étape 1), la liste chronologique
  des révisions (une par génération pour cette semaine) et, pour chaque article, l'évolution de sa
  quantité proposée d'une révision à l'autre (ex: "révision 1 = 48, révision 2 = 156, +108"), trié
  par variation absolue décroissante pour faire remonter en premier ce qui a le plus changé. Deux
  routes l'exposent : `GET /reassort/weekly-plan/current` (plan de la semaine en cours du magasin
  courant) et `GET /reassort/weekly-plan/:id/history`. Purement une lecture de ce qui est déjà
  persisté à chaque génération (aucun appel RPOS, aucun recalcul). Pas encore d'affichage frontend
  à cette étape — API testée directement. Voir `getWeeklyPlanHistory`/`findWeeklyPlanForDate` dans
  `weeklyPlanService.js`.
- ✅ **Étape 3 — Réajustement quotidien continu** (§15-16) : nouveau job `dailyReplenishmentReviewJob`
  (planifié via `DAILY_REVIEW_CRON`, 6h30 par défaut) qui, pour chaque plan hebdomadaire dont la
  dernière révision n'est pas encore validée, recalcule la proposition et ne crée une nouvelle
  révision que si le total proposé change de plus de `REVISION_CHANGE_THRESHOLD` (10% par défaut,
  §16) — sinon le plan reste inchangé. Le calcul de comparaison est réutilisé tel quel pour la
  sauvegarde (pas de second calcul RPOS identique), et la nouvelle révision est explicitement
  rattachée au plan revu même si son propre calcul de semaine cible diverge (ex: config de période
  du magasin changée entre-temps) — sans ce garde-fou, la continuité des révisions pouvait casser.
  **Version simple assumée à cette étape** : seuls les plans PAS encore validés sont concernés ; le
  calcul du besoin restant après une commande déjà validée (§14, distinction
  `recommendedQuantity`/`orderedQuantity`) est une étape ultérieure, plus complexe. Vérifié avec des
  données réelles (magasin 110) : pas de nouvelle révision à 0.1% de variation avec le seuil à 10%,
  nouvelle révision créée avec un seuil abaissé, rattachement au bon plan confirmé après correction
  du bug de divergence. Voir `backend/src/jobs/dailyReplenishmentReviewJob.js`.
- ✅ **Étape 4 — Historique des prédictions** (§21) : nouveau modèle `AIPrediction`, une ligne par
  article à chaque génération de proposition (nocturne, manuelle ou réajustement quotidien) —
  aucun recalcul, on persiste simplement ce que `generateProposal` produit déjà (vente moyenne
  hebdo/jour prévue, méthode de prévision, stock et commandes en cours au moment du calcul), avec
  la semaine cible reprise du `WeeklyReplenishmentPlan` rattaché. Colonnes `confidenceScore` et
  `model`/`modelVersion` posées dès maintenant pour éviter une seconde migration aux étapes 6/8,
  mais pas encore renseignées par un vrai calcul de confiance à ce stade. Purement une base de
  données pour permettre la comparaison prédiction/réalité de l'étape 5 : aucun changement de
  comportement visible, pas encore d'affichage frontend. Route de lecture ajoutée :
  `GET /reassort/predictions/:proposalId`. Voir `AIPrediction` dans `schema.prisma` et
  l'écriture dans `generateAndSaveProposal` (`proposalService.js`).
- ✅ **Étape 5 — Résultat réel vs prédiction** (§22) : nouveau modèle `AIPredictionOutcome` et
  job planifié `predictionOutcomeJob` (`PREDICTION_OUTCOME_CRON`, 7h par défaut) qui, pour chaque
  `AIPrediction` (étape 4) dont la semaine cible est terminée et pas encore évaluée, calcule les
  ventes réelles sur la période (`SalesLine`, déjà synchronisées localement — aucun appel RPOS),
  le stock actuel en cache, et la quantité effectivement commandée si la proposition a été validée.
  Calcule `forecastError` (actual − predicted), `absoluteError` et `percentageError` (`null` si
  `actualSales = 0`, cf. §22). **Limite assumée** : le stock persisté est celui au moment de
  l'évaluation (pas d'historique de stock à la date exacte de fin de période). Purement une mesure
  de fiabilité : ne modifie aucune proposition, aucun plan, aucun calcul existant. Interrupteur et
  planification ajoutés sur la page Paramètres (onglet Planification, carte "Évaluation des
  prédictions"). Voir `backend/src/jobs/predictionOutcomeJob.js` et `AIPredictionOutcome` dans
  `schema.prisma`.
- ⬜ Étape 6 — Moteur de confiance (§20, §23)
- ⬜ Étape 7 — Détection d'anomalies (§30-31)
- ⬜ Étape 8 — Moteur de recommandation IA typée (§18-19)
- ⬜ Étape 9 — AI Center (dashboard de performance IA, §44-46)
- ⬜ Étape 10 — LDAP + RBAC étendu (§39-42)
- ⬜ Étape 11 — Chatbot IA (§34-38)
- ⬜ Étape 12 — Shadow Mode (§50)
- ⬜ Étape 13 — Réassort automatique contrôlé (§26-29)
- ⬜ Étape 14 — Réassort automatique complet

## 📦 Installation

### Prérequis

- Node.js >= 18
- PostgreSQL
- Docker (recommandé)

### Avec Docker (recommandé)

```bash
# Copier et personnaliser les variables d'environnement
cp .env.example .env
cp backend/.env.example backend/.env
# Éditer .env (mot de passe Postgres) et backend/.env (JWT_SECRET, identifiants RPOS)

docker compose up -d --build
```

- Backend : `http://localhost:3001`
- Frontend : `http://localhost:8080`

### Setup local sans Docker (backend seul)

```bash
cd backend
npm install
cp .env.example .env
# Éditer .env

npm run db:generate
npm run db:push
npm run dev
```

## 🗄️ Base de données

Schéma complet dans [`backend/prisma/schema.prisma`](backend/prisma/schema.prisma). Modèles
principaux : `User`, `RposServer`, `Shop`, `ReassortConfig`, `Proposal` / `ProposalLine` /
`ProposalOrder`, `SalesLine`, `SalesBackfillRun`, `AiProviderKey` / `AiForecastRun`, `SystemConfig`.

### Formule de calcul de la quantité proposée

```
besoin = (vente moyenne hebdomadaire / 7 × jours de couverture) + stock de sécurité
       − stock actuel − quantité déjà en commande

quantité proposée = besoin arrondi au multiple de colisage supérieur (jamais de sous-livraison)
```

Détail dans `backend/src/services/proposalService.js`, fonction `computeQuantityToOrder`.

## 📚 Documentation

- **[readme.md](readme.md)** — cahier des charges fonctionnel complet (contexte métier, sections détaillées)
- **[TECH_STACK.md](TECH_STACK.md)** — langages utilisés, où et pour quel calcul
- **[THEME_SYSTEM.md](THEME_SYSTEM.md)** — système de thème CSS/JS du frontend

## 📝 Licence

Usage interne Prosuma.
