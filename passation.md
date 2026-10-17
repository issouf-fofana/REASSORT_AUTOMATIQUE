# Passation — mise à jour du 17/10/2026 (soir)

Remplace la passation du 13/10/2026. Session très longue : construction complète du **module
Ruptures de stock** (nouveau, de zéro), de la détection à une fiche de détail très riche, guidée en
direct par l'utilisateur à coups de captures d'écran et d'allers-retours. Points hérités du 13/10
toujours ouverts, voir section dédiée en bas.

## ⚠️ Pièges récurrents à vérifier en premier

1. **`SystemConfig` en base prime toujours sur le code** — une fois qu'une ligne existe pour une
   clé, modifier le code et déployer ne change rien tant que la ligne en base n'est pas aussi mise
   à jour/supprimée (`systemConfigService.js`).

2. **Build Docker impossible dans ce sandbox** (`docker compose build` échoue sur
   `binaries.prisma.sh` via `getaddrinfo EAI_AGAIN`, réseau sandbox bloqué). Workaround systématique
   utilisé toute la session : builder le frontend sur l'hôte (`npm run build` dans
   `frontend/react-app-shell/`) puis `docker cp dist` dans le conteneur ; côté backend, `docker cp`
   directement les fichiers `.js` modifiés + `docker restart`. **Conséquence importante** : ces
   déploiements locaux ne touchent QUE le conteneur en cours d'exécution, jamais l'image Docker —
   un `docker compose up -d --force-recreate` repart de l'ancienne image et perd tout. Le vrai
   déploiement (Dokploy) reconstruit une image propre à partir du code source commité, donc c'est
   fiable là-bas ; c'est uniquement le test local qui demande ce contournement.

3. **nginx local a besoin d'un bloc par route SPA dynamique** — `location =` (match exact) pour une
   route fixe, mais pour une route avec paramètre (`/stockouts/episode/:id`), `alias` sur une
   location-préfixe casse le chemin (concatène le reste de l'URI après la cible) : utiliser un
   `rewrite ... last` vers une seconde location exacte. Piège déjà rencontré une fois, documenté
   dans `frontend/nginx.conf`.

## Ce qui a été fait (module Ruptures de stock, 16-17/10/2026)

Nouveau module complet, basé sur `rupture.md` (cahier des charges), **sans données entrepôt
(Cyrus)** — diagnostic de cause volontairement simplifié (AMONT_A_PRECISER regroupe plusieurs cas
qu'on ne peut pas distinguer sans Cyrus).

### Détection et diagnostic
- `StockSnapshot` (capture périodique du stock, job `stockSnapshotJob.js`, 6h par défaut) +
  `StockoutEpisode` (ouverture/fermeture automatique selon transition stock>0 ↔ stock<=0).
- Diagnostic de cause (`diagnoseCause`) figé à l'ouverture de l'épisode, jamais réévalué —
  distinct de `reactionStatus` (calculé à chaque lecture, toujours à jour).
- `reactionStatus` : REAGI / EN_ATTENTE (<24h) / RETARD (24-48h) / MAGASIN_NA_PAS_REAGI (>48h sans
  commande) / STOCK_PEUT_ETRE_PAS_A_JOUR (aucune vente ni commande depuis le début — garde-fou
  prioritaire sur les seuils de durée, pour ne jamais accuser le magasin sans preuve).

### Pages
- **`/stockouts`** (`Stockouts.tsx` → `StockoutShopDetail.tsx`) : navigation hiérarchique
  Secteur → Rayon → Articles (identique à Proposition de commande), avec KPI compacts, graphes
  repliables (courbe 30j + donut causes), et "Analyse par rayon" condensée (3 chiffres + tableau,
  pas de grosses tuiles). Secteur/rayon sélectionnés reflétés dans l'URL (`?sector=&dept=`) pour que
  le retour depuis la fiche de détail revienne exactement au bon niveau.
- **`/stockouts/episode/:id`** (`StockoutEpisodePage.tsx`) : fiche de détail très riche, header
  navy contrasté, 4 tuiles, timeline horizontale, puis sections Informations générales / Métriques
  temporelles / **Détection-Commande-Prise en charge** (numéro de commande RPOS, qui a créé/validé
  et quand — via appel RPOS réel `/api/supplier_order/`, pas juste nos données internes) /
  **Niveau de stock** (voir ci-dessous) / Impact commercial / Historique des mouvements.

### Liste d'articles enrichie (niveau "Articles" de la navigation)
- Colonne **Réaction** (badge commande passée/en attente/retard/sans réaction) + filtre
  Toutes/Avec commande/Sans commande/Livrées.
- Colonne **Livraison** (Sans commande / Commandé pas livré / Livrée) + **Livré le** (date).
- Tout calculé **en masse** côté backend (`getOpenEpisodes`, 2 requêtes pour tout le magasin,
  matching en mémoire) — jamais un appel par article, ~50-65ms mesurés sur 238 ruptures réelles.

### Chronomètres live
- Les durées (totale, avant/après commande) se recalculent chaque seconde côté client à partir des
  timestamps bruts, pas des valeurs figées au chargement. Affichage avec minutes/secondes
  (`formatDurationLive`, ex: "1j 5h 23min 47s") sur la fiche de détail — **piège rencontré** :
  `formatDuration()` classique arrondit à l'heure près, donc un calcul qui tourne bien semblait
  visuellement figé pendant près d'une heure. Toujours vérifier côté affichage, pas seulement le
  calcul, avant de conclure à un bug.
- Liste d'articles : tick minute (pas seconde, trop coûteux pour des centaines de lignes).

### Niveau de stock (fiche de détail)
Section dédiée avec code couleur (rouge=négatif, ambre=0, vert=positif) : stock au début de la
rupture, stock actuel/dernier relevé, stock RPOS temps réel (`ProductCache`), stock après
résolution, et **stock après arrivage** (ancré sur `order.actualReceptionDate`, distinct de "après
résolution" qui peut venir d'une vente sans commande). Bandeau d'alerte explicite si stock négatif
détecté (signe de désynchro RPOS plutôt que rupture physique).

### Perte estimée (CA perdu)
- Méthode : vente moyenne du **même jour de semaine** (ex: vendredis vs vendredis) sur une fenêtre
  de recul, comparée aux ventes réellement constatées pendant la rupture.
- **Bug de performance trouvé et corrigé** : recalculer cette perte en temps réel à CHAQUE lecture
  de page (pour tous les épisodes ouverts) faisait ~3s par endpoint avec plusieurs centaines de
  ruptures — page bloquée sur "Chargement...". Corrigé en précalculant via un nouveau job
  (`stockoutLossRecalcJob.js`, toutes les heures) qui stocke `qtyPerdueEstimee`/`caPerdueEstime`
  pour les épisodes EN_COURS ; les pages ne font plus que lire ce champ stocké.
- Perte séparée avant/après commande (`lossBeforeOrder`/`lossAfterOrder`), pas une seule perte
  globale.
- Fenêtre de comparaison étendue de 8 à **52 semaines** (1 an, capture la saisonnalité), seuil de
  fiabilité minimum relevé de 4 à **8 semaines comparables**.

### Paramètres ajoutés (Paramètres > Planification, carte "Délais du module Ruptures de stock")
Tous nouveaux le 17/10/2026, suivent le patron `systemConfigService.js` existant :
1. **Délai de réaction attendu** (défaut 24h) — seuil pour passer au statut "Retard".
2. **Délai de livraison maximum** (défaut 48h) — seuil "magasin n'a pas réagi" + bandeau d'alerte.
3. **Fenêtre de comparaison** (défaut 52 semaines) — recul pour le calcul de CA perdu.
4. **Minimum de semaines comparables** (défaut 8) — en dessous, estimation affichée "indisponible".

### Autres correctifs du même module
- Bug "Sans secteur" (414/414 articles) : `diagnoseCause` ne tourne qu'à la création d'un épisode,
  jamais en relecture — script de rattrapage `backend/scripts/backfillStockoutEpisodeSector.js`
  créé, **pas encore lancé en production** (à faire par l'utilisateur).
- Bug critique de routage réseau (prod) : `BACKEND_URL` vide faisait tomber le frontend sur
  `window.location.hostname:3001` (port backend non accessible depuis d'autres postes du réseau,
  seul le poste de l'utilisateur y avait accès) — corrigé en configurant `BACKEND_URL=/api-backend`
  (proxy nginx déjà existant) dans `docker-compose.yml` local ; **à vérifier côté Dokploy en prod**
  si le même symptôme apparaît ailleurs.

## Ce qui N'A PAS été fait / reste en suspens

1. **Backfill secteur en production** — script prêt (`backfillStockoutEpisodeSector.js`), jamais
   exécuté sur le serveur de prod.
2. Hérité du 13/10, toujours ouvert :
   - **117 articles à `ProductCache.stock` aberrant** (prévisions IA faussées) — jamais investigué
     plus loin, liste jamais sortie pour vérification terrain.
   - **Page de connexion (`/login`)** — dernier état (commit `5d077f5` au 13/10) à confirmer comme
     poussé/déployé et validé par l'utilisateur ; pas re-vérifié pendant cette session.
3. **"Guide d'utilisation"** — toujours en attente de captures d'écran de l'utilisateur.

## Repères techniques utiles pour la suite

- Module Ruptures : `backend/src/services/stockoutEpisodeService.js` (cœur de toute la logique —
  fichier conséquent, bien commenté section par section), `backend/src/jobs/stockSnapshotJob.js`
  (détection) + `stockoutLossRecalcJob.js` (perte précalculée), routes dans
  `backend/src/routes/reassort/insights.js`.
- Frontend : `frontend/react-app-shell/src/pages/Stockouts/` — `Stockouts.tsx` (page racine, 2
  onglets Ce magasin/Tous les magasins), `StockoutShopDetail.tsx` (navigation hiérarchique + liste
  d'articles), `StockoutEpisodePage.tsx` (fiche de détail), `StockoutDepartmentAnalysis.tsx`
  (analyse par rayon condensée).
- Seuils configurables : `systemConfigService.js` clés `STOCKOUT_REACTION_DEADLINE_HOURS`,
  `STOCKOUT_DELIVERY_DEADLINE_HOURS`, `STOCKOUT_LOSS_LOOKBACK_WEEKS`,
  `STOCKOUT_LOSS_MIN_COMPARABLE_WEEKS` — UI dans `SchedulingSection.tsx`.
- Shell unifié : `frontend/react-app-shell/` — toutes les pages y sont, plus aucune route
  `location ^~ /<page>-app/` dans `nginx.conf`.
- Déploiement serveur de prod : Dokploy, accès terminal via conteneur backend (`cd /app`). Rebuild
  standard côté sandbox local : voir piège n°2 ci-dessus (workaround `docker cp`, jamais un vrai
  rebuild d'image).
- MCP Claude in Chrome resté déconnecté toute la session — aucune vérification visuelle directe
  possible, diagnostics faits via `curl` côté serveur + scripts collés par l'utilisateur dans sa
  propre console navigateur (ex: confirmation du chronomètre live via
  `document.querySelectorAll('.ep2-field dd')`).
