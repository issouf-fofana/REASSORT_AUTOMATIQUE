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

> **UX Paramètres (14/09/2026)** : la navigation par section vit dans la sidebar
> (`/settings#tab-xxx`, règle : toute fonctionnalité = lien sidebar + page dédiée, pastilles
> versionnées dans `layout.js`) — la barre d'onglets en haut est masquée et remplacée par des
> pastilles courtes par section (champs pour Réassort/Fichiers, cartes pour les autres onglets,
> libellés raccourcis via `SHORT_LABELS` dans `settings.html`, barre figée `sticky` — nécessite
> `main.content { overflow: visible }` car Volt impose `overflow: hidden` qui casse le sticky).
>
> **UX sidebar (14/09/2026)** : menu plat par sections (Pilotage/Réassort/Administration, aucun
> groupe repliable), état actif suivi par hash, bouton topbar pour masquer/afficher le menu sur
> desktop (état mémorisé en `localStorage`, hamburger overlay inchangé sur mobile).

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
  `weeklyPlanService.js`. Corrigé le 14/09/2026 : chaque point d'historique porte désormais
  `changeVsPrevious` (écart vs révision précédente) et chaque article `maxStepVariation` (plus
  gros saut d'une révision à l'autre) — le tri retient le max entre variation globale et plus
  gros saut, pour que les allers-retours (100 → 200 → 100, variation globale 0) remontent aussi.
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
  l'écriture dans `generateAndSaveProposal` (`proposalService.js`). Corrigé le 14/09/2026 : si le
  rattachement au plan échoue, alerte `ALERTE` explicite dans les logs (nightly + génération
  manuelle) + flag `weeklyPlanAttached` retourné — sans plan, les prédictions sont écrites avec
  une semaine cible null et ignorées silencieusement par l'évaluation, il fallait un signal.
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
- ✅ **Étape 6 — Moteur de confiance** (§20) : nouveau service `confidenceService.js`, calcule un
  `confidenceScore` (0-100) par article à chaque génération, à partir des 4 signaux ayant déjà une
  source de données fiable dans ce projet : quantité d'historique de vente, volatilité (coefficient
  de variation des ventes journalières), précision des prédictions passées pour cet article
  (`AIPredictionOutcome`, étape 5 — score neutre à 50 tant qu'aucune évaluation n'existe encore,
  plutôt qu'une fausse confiance à 100 ou une pénalité injuste à 0), et qualité des données (rupture
  de stock détectée sur la période). **Version honnête assumée à cette étape** : le §20 liste
  10 critères idéaux (dont détection d'anomalies et comportement magasin/article) ; ceux qui
  dépendent d'étapes pas encore faites (anomalies = étape 7) ou d'un modèle pas encore construit ne
  sont pas simulés — le score s'enrichira naturellement à mesure que ces étapes avanceront, sans
  casser ce qui existe déjà. Renseigne `AIPrediction.confidenceScore` (colonne posée mais vide
  depuis l'étape 4) et enrichit `reasoning` avec le détail par signal. Testé avec une génération
  réelle sur le magasin 110. Voir `backend/src/services/confidenceService.js`.
- ✅ **Étape 7 — Détection d'anomalies** (§30-31) : nouveau service `anomalyService.js`
  (`detectAnomalies`), signaux explosion/chute de ventes + stock incohérent + tendance
  (GROWING/DECLINING/STABLE/VOLATILE/UNKNOWN), branché sur le moteur de confiance
  (`confidenceService.js`, pénalité qualité de données) et persisté par ligne
  (`trendCategory`, `anomalies`). Corrigé le 11/09/2026 : intention chatbot “CA”
  (`chatbotService.js`) ne matche plus les salutations (“comment ça va ?”).
  Corrigé le 14/09/2026 : seuil “rupture invisible” paramétrable (`ANOMALY_MIN_DAILY_SALES`,
  défaut 1 unité/jour, champ dédié dans Paramètres > IA, validation serveur incluse) —
  baissable à 0.5 pour surveiller aussi les articles lents. Tests : `npm test` (jest,
  26 tests `proposalService`/`forecastService`/`anomalyService` verts).
- ⬜ Étape 8 — Moteur de recommandation IA typée (§18-19)
- ⬜ Étape 9 — AI Center (dashboard de performance IA, §44-46) — première brique posée le
  14/09/2026 : **Conseiller d'amélioration IA** (`improvementService.js`, modèle
  `AIImprovement`, page `Améliorations IA` dans sidebar > Réassort). Chien de garde à
  8 détecteurs déterministes (jobs en échec, prédictions non évaluables, précision/biais par
  magasin, propositions périmées, synchro en retard, questions chatbot sans réponse, anomalies
  récurrentes) + enrichissement LLM (action exploitation + reco dev, repli déterministe sans IA).
  Boucle d'apprentissage : métrique figée au constat, statut `APPLIED` posé par l'humain,
  évaluation auto `IMPROVED`/`NO_EFFECT`. Routes `GET /improvements`, `POST
  /improvements/generate`, `POST /improvements/:id/status` (ADMIN). Vérifié en prod : 2 vrais
  problèmes silencieux détectés dès le premier run (synchro ventes coupée + 71h de retard).
  Transparence (14/09/2026) : prompt exact envoyé au LLM (`aiPrompt`) et erreur
  d'enrichissement (`aiError`) persistés et visibles sur chaque carte (déroulant "Voir le
  prompt"). Barrière anti-doublons sur type+périmètre+métrique.
  Traçabilité complète (14/09/2026) : priorités Critique/Élevée/Moyenne/Faible (tri par
  priorité), message d'erreur exact (`errorMessage`, jamais reformulé), confiance IA
  (`aiConfidence`), statuts En cours/À vérifier/Appliqué(+note de la correction réelle)/Ignoré
  (+motif obligatoire)/Rouvrir — IMPROVED/NO_EFFECT réservés au système. Timeline par
  recommandation (`AIImprovementEvent` : Détection → Analyse IA → Recommandation → Validation
  → Correction → Vérification → Résultat, avec acteur et note), contexte Qui/Où/Quand
  (`detectedBy`, IP, version, environnement). Routes `GET /improvements?priority=&sort=`,
  `GET /improvements/:id` (détail + timeline). Page : filtres, modale de détail, modale de
  note. Rien ne disparaît : les ignorées/appliquées restent consultables avec leur historique.
  Chien de garde planifié quotidiennement (7h30, `IMPROVEMENTS_CRON`, `IMPROVEMENTS_ENABLED`).
  Debug global (14/09/2026) : table `ErrorReport` alimentée par TOUTES les pages frontend
  (`layout.js` : `onerror` + promesses rejetées, dédup 60s, plafond 20/page) et TOUTES les
  réponses API 5xx (hook `server.js`, quel que soit le chemin de code) — oui, toutes les vues
  sont couvertes. Détecteur `APP_ERROR` : regroupe par signature normalisée (nombres/EAN/UUID
  → #), seuil ≥3 occurrences, message exact conservé, métrique `app_error_max_count`.
  Rétention 30j + plafond 5000 (élagage à chaque run). Page dédiée **Journal d'audit**
  (sidebar > Réassort, ADMIN) : les 100 dernières erreurs brutes avec filtre source — règle
  : toute fonctionnalité = lien sidebar + page dédiée. Vraie IP LAN (14/09/2026) : backend en
  `network_mode: host` dans `docker-compose.yml` (le NAT Docker masquait les postes derrière la
  passerelle 172.x) + `trust proxy` pour les déploiements derrière reverse proxy. Vérifié :
  4 erreurs page groupées en 1 constat (35/35 tests jest verts).
  Robustesse (14/09/2026) : page blindée anti cache-mixte (vieux HTML + JS neuf ne tue plus
  tout le script — chaque liaison est gardée), enrichissement IA en parallèle ×3 (fini les
  minutes de bouton figé), journal d'audit visible sur la page (100 dernières erreurs brutes
  avec contexte : base preuve que chaque bug est sauvé avant analyse).
- ⬜ Étape 10 — LDAP + RBAC étendu (§39-42)
- ✅ **Étape 11 — Chatbot IA** (§34-38) : `chatbotService.js` (intent déterministe par
  mots-clés → outils → LLM, jamais d'accès direct base, §35) + `chatbotToolsService.js`
  (stock, ventes, CA, Pareto recalculé depuis `SalesLine`, ruptures, surstock, précision IA,
  commandes), conversations persistées (`ChatbotConversation/Message`), page
  `ai-assistant.html` + widget flottant sur toutes les pages. Vérifié en prod : 4
  conversations, réponse Pareto réelle (1316 articles = 80% CA).
- ⬜ Étape 12 — Shadow Mode (§50)
- ⬜ Étape 13 — Réassort automatique contrôlé (§26-29)
- ⬜ Étape 14 — Réassort automatique complet

> **Correctifs transverses du 14/09/2026** : client Prisma unique partagé
> (`backend/src/utils/prisma.js`, 25 fichiers migrés — avant, chaque fichier ouvrait son propre
> pool de connexions, risque d'épuisement sous charge concurrente) ; `npm test` ajouté
> (jest, `computeParetoFromLines` ré-exporté car les tests existants l'attendaient).
> Limites assumées restantes (chantiers d'étapes ultérieures, pas des bugs) : distinction
> `recommendedQuantity`/`orderedQuantity` du §14 (requiert schéma + tunnel de validation —
> `actualOrders` de l'évaluation reprend donc la quantité recommandée) et `percentageError`
> à null quand les ventes réelles sont nulles (§22, exclues du score plutôt que pénalisées —
> un zéro peut aussi venir d'une rupture, pas d'une mauvaise prévision).

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
