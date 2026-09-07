# Stack technique — langages, rôle et calculs

Ce document répertorie tous les langages/technologies présents dans le dépôt, où ils sont utilisés,
et quelles fonctionnalités ou calculs métier ils implémentent. Le cahier des charges fonctionnel
complet est dans [readme.md](readme.md) ; ce fichier-ci répond à la question « quel langage fait
quoi et où ».

## Vue d'ensemble

| Langage / techno       | Rôle                                      | Où                          |
|-------------------------|--------------------------------------------|------------------------------|
| **JavaScript (Node.js)** | Backend — API, calculs métier, jobs planifiés | `backend/src/`               |
| **JavaScript (navigateur)** | Frontend — UI, appels API, graphiques    | `frontend/`                  |
| **HTML**                | Structure des pages                       | `frontend/*.html`            |
| **CSS**                 | Mise en forme, thème                      | `frontend/assets/css/`       |
| **SQL (via Prisma)**    | Schéma et requêtes base de données        | `backend/prisma/schema.prisma` |
| **Python**              | Prototypes exploratoires (historique, non actifs) | `backend/*.py`         |
| **YAML**                | Orchestration des conteneurs               | `docker-compose.yml`         |
| **Dockerfile**          | Construction des images                    | `backend/Dockerfile`, `frontend/Dockerfile` |

---

## 1. Backend — JavaScript (Node.js)

Le cœur du système. Express pour l'API HTTP, Prisma comme ORM PostgreSQL, `node-cron` pour les
tâches planifiées.

### 1.1 Calculs métier (`backend/src/services/`)

| Fichier | Calcul / fonctionnalité |
|---|---|
| `proposalService.js` | **Cœur du réassort** : classement Pareto 80/20 des ventes (`computeParetoFromLines`), calcul de la quantité à commander (`computeQuantityToOrder` = vente prévue + stock de sécurité − stock actuel − déjà en commande, arrondi au colisage supérieur), regroupement des commandes par rayon à la validation. |
| `forecastService.js` | Prévision de vente par **lissage exponentiel** (alternative à la moyenne plate), pondère les ventes récentes plus fort que les anciennes ; retombe sur la moyenne si l'historique est trop court (< 14 jours). |
| `aiForecastService.js` | Intégration LLM (Gemini/OpenAI/Anthropic) : construit un résumé par article (vente moyenne, historique jour par jour, stock, colisage) et demande une quantité alternative à l'IA, avec bascule automatique entre plusieurs clés API en cas d'échec. |
| `productAnalyticsService.js` | Analyse d'un article sur une période choisie : agrégation de la série de ventes (granularité adaptative heure/jour/semaine/mois), reconstruction d'une courbe de stock estimée (RPOS ne conserve pas l'historique de stock réel), prédiction de la prochaine commande. |
| `salesBackfillService.js` | Récupération d'historique de ventes par tranches (pour rester sous les limites RPOS), avec reprise après interruption page par page. |
| `salesFileService.js` | Lecture des fichiers CSV d'export de ventes (déposés sur un dossier réseau ou importés via l'UI), utilisée en priorité avant un appel RPOS. |
| `rposClient.js` | Client HTTP vers l'API RPOS (ERP/POS Prosuma) : lecture produits/ventes/commandes, création et validation de commandes fournisseur, gestion des retries et du chiffrement des identifiants. |
| `cryptoService.js` | Chiffrement AES-256-GCM des secrets stockés en base (mots de passe RPOS, clés API IA) — jamais de secret en clair en base de données. |

### 1.2 Jobs planifiés (`backend/src/jobs/`, cron via `node-cron`)

| Job | Fréquence | Fonction |
|---|---|---|
| `nightlyProposalJob.js` | Nocturne (configurable) | Génère la proposition de réassort de tous les magasins actifs ; déclenche l'analyse IA automatique si l'historique est suffisant. |
| `salesSyncJob.js` | Toutes les 15 min | Synchronise les ventes récentes de chaque magasin en local (évite de solliciter RPOS à chaque consultation). |
| `receptionSyncJob.js` | Horaire | Suit le statut des commandes fournisseur envoyées, marque les annulations et estime les réceptions selon le délai configuré. |
| `shopsSyncJob.js` | Horaire | Synchronise la liste des magasins par serveur RPOS en local. |

### 1.3 API HTTP (`backend/src/routes/`, `backend/src/middleware/`)

Express REST classique : `reassort.js` (toutes les routes métier réassort/propositions/IA/synchronisation), `auth.js` (connexion JWT avec limitation anti-brute-force), `users.js` (gestion des comptes). Middleware `auth.js` : vérification du token JWT et des rôles (ADMIN/SUPERVISOR/STORE).

---

## 2. Frontend — HTML / CSS / JavaScript (navigateur)

Pages HTML statiques (template Larkon, Bootstrap 5), servies par Nginx. Aucun framework JS
(React/Vue) : JavaScript vanilla directement dans chaque page, dans des balises `<script>`.

| Fichier | Fonctionnalité |
|---|---|
| `purchase-order.html` | Page principale : navigation Secteur → Rayon → Articles, saisie des quantités (avec colisage), validation et envoi à RPOS, graphique d'évolution d'un article (ApexCharts), analyse IA à la demande. |
| `settings.html` | Paramètres : seuils de calcul, connexions RPOS multi-serveurs, synchronisation des ventes (avec pause/reprise/annulation), import de fichiers CSV, gestion des clés API IA. |
| `purchase-list.html` | Historique des propositions et commandes validées. |
| `sales-history.html` | Consultation des ventes synchronisées en local. |
| `admin-dashboard.html`, `users-list.html` | Vue d'ensemble multi-magasins, gestion des comptes utilisateurs. |
| `assets/js/theme.js` | Moteur de thème (clair/sombre, couleur d'accent) — voir [THEME_SYSTEM.md](THEME_SYSTEM.md). |
| `assets/js/reassort-auth.js` | Gestion du token JWT côté navigateur, wrapper `fetch` authentifié. |

Bibliothèques externes (via CDN) : Bootstrap 5 (mise en page, modals), ApexCharts (graphiques de vente/stock), Iconify (icônes).

---

## 3. Base de données — PostgreSQL (schéma défini en Prisma)

Le schéma (`backend/prisma/schema.prisma`) est écrit dans le langage de modélisation Prisma, qui
génère le SQL réel (migrations) et le client JavaScript typé utilisé par le backend. Modèles
principaux : `User`, `RposServer`, `Shop`, `ReassortConfig`, `Proposal`/`ProposalLine`/`ProposalOrder`,
`SalesLine`, `SalesBackfillRun`, `AiProviderKey`/`AiForecastRun`, `SystemConfig`.

---

## 4. Python — prototypes historiques (non actifs en production)

Cinq scripts à la racine de `backend/`, antérieurs au backend Node actuel — conservés à titre de
référence/historique, **jamais exécutés par le système en production** :

| Script | Ce qu'il faisait |
|---|---|
| `pareto_analysis.py` | Premier prototype du calcul Pareto 80/20, à partir d'un export CSV RPOS local (logique aujourd'hui réimplémentée en JS dans `proposalService.js`). |
| `generate_proposal.py` | Premier prototype du calcul de quantité à commander, en lisant la sortie CSV de `pareto_analysis.py`. |
| `api_commande.py` | Script d'extraction des commandes fournisseur RPOS par pagination — a servi à explorer l'API avant l'écriture de `rposClient.js`. |
| `test_api.py` | Script de test de connexion à l'API RPOS (identifiants `.env`) — a permis de découvrir le comportement réel de plusieurs champs API (dont le bug de colisage `ordering_unit` corrigé début septembre 2026). |
| `login_ldap.py` | Prototype d'authentification LDAP contre l'annuaire Prosuma — jamais intégré (le système utilise l'authentification par compte/mot de passe classique, `backend/src/routes/auth.js`). |

Si un besoin réapparaît (authentification LDAP, par exemple), ces scripts servent de point de
départ mais nécessitent une réécriture en JS pour s'intégrer au backend actuel.

---

## 5. Infrastructure — Docker / YAML

| Fichier | Rôle |
|---|---|
| `docker-compose.yml` | Orchestration des 3 services : `postgres` (base de données), `backend` (API Node), `frontend` (Nginx servant les fichiers statiques). Variables sensibles (mot de passe Postgres) externalisées via `.env` (voir `.env.example`). |
| `backend/Dockerfile` | Image Node 18 Alpine, build multi-étage (installation des dépendances, génération du client Prisma, puis image d'exécution allégée). |
| `frontend/Dockerfile` | Image Nginx Alpine servant les fichiers HTML/CSS/JS statiques. |

---

## Où regarder pour…

- **Comprendre un calcul de quantité** → `backend/src/services/proposalService.js`, fonction `computeQuantityToOrder`.
- **Comprendre l'intégration RPOS** (et ses bugs déjà corrigés : colisage, filtres de date ignorés) → `backend/src/services/rposClient.js`.
- **Modifier l'apparence d'une page** → `frontend/assets/css/theme.css` et [THEME_SYSTEM.md](THEME_SYSTEM.md).
- **Ajouter un job planifié** → `backend/src/jobs/`, puis l'enregistrer dans `backend/src/jobs/cronManager.js`.
- **Comprendre le cahier des charges métier d'origine** → [readme.md](readme.md).
