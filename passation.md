# Passation — mise à jour du 13/10/2026 (soir)

Remplace la passation précédente du 13/10 matin (tous ses points "En cours" ont depuis été résolus
ou dépassés, voir ci-dessous). Session longue : investigation + fix d'un bug de métriques IA,
plusieurs bugs réels trouvés sur le shell post-fusion (sélecteur de magasin manquant, bug
SUPERVISOR), et une très longue série d'itérations visuelles sur la page de connexion (`/login`),
guidées en direct par l'utilisateur à coups de captures d'écran.

## ⚠️ Pièges récurrents à vérifier en premier

1. **`SystemConfig` en base prime toujours sur le code** — une fois qu'une ligne existe pour une
   clé, modifier le code et déployer ne change rien tant que la ligne en base n'est pas aussi mise
   à jour/supprimée (`systemConfigService.js`).

2. **Le disque du sandbox local sature très souvent pendant cette session** (`/dev/nvme0n1p5` à
   95-100%, `/tmp` plein → échecs `ENOSPC` sur Bash/Edit/Write, y compris pendant un `docker compose
   build`). Cause : accumulation de snapshots **Timeshift**. À chaque blocage, demander à
   l'utilisateur de supprimer un ou plusieurs snapshots Timeshift (app graphique) — libère
   généralement 5-6 Go et débloque tout. Pas de solution définitive trouvée cette session ; si ça se
   reproduit systématiquement, il faudrait proposer à l'utilisateur de désactiver/espacer les
   snapshots automatiques.

## En cours (à reprendre en premier)

1. **Bug de précision des prévisions IA — partiellement corrigé, cause racine réelle non traitée.**

   Deux bugs distincts :
   - ✅ **Corrigé et commité** (`9ffc976` puis fix définitif) — `predictionOutcomeJob.js` comparait
     les ventes réelles à `predictedQuantity` (quantité à **commander**, toujours artificiellement
     plus grande) au lieu de `predictedWeeklyDemand` (vraie prévision de vente). Un script de
     backfill a recalculé les ~9836 lignes `AIPredictionOutcome` existantes avec la bonne formule.
   - ❌ **PAS corrigé.** Après le fix ci-dessus, les métriques globales ont à peine bougé (WAPE
     toujours >3000%) — preuve que le vrai problème est que `predictedWeeklyDemand` lui-même est
     aberrant pour certains articles. Cause tracée : **117 articles** ont un `ProductCache.stock`
     aberrant (ex: 26708, voire 231777 "unités/semaine" prédites) **ET** zéro vente historique —
     pattern systémique (100% des cas testés), probablement un bug de synchro RPOS (mauvaise unité
     ou flux cassé pour ces références), pas un bug du calcul IA. **Prochaine étape jamais faite** :
     sortir la liste des 117 (EAN, magasin, stock) pour vérification terrain par l'utilisateur dans
     RPOS/en magasin.

2. **Page de connexion (`/login`) — très nombreuses retouches visuelles, dernier état non vérifié
   en conditions réelles par l'utilisateur sur le dernier commit.**

   L'utilisateur a guidé une longue série d'allers-retours de style via captures d'écran. État final
   (commit `5d077f5`, **pas encore poussé sur `origin/master`**) :
   - Carte centrée classique (`max-w-5xl`, deux panneaux 50/50), pas plein écran.
   - Panneau gauche : animation canvas interactive `DotMap.tsx` (points connectés, répulsion
     magnétique au survol de la souris) — remplace définitivement l'image statique Tiny-man.jpg
     essayée puis rejetée entre-temps (`cc96781`).
   - Panneau droit : logo seul (noir, `brightness-0`, sans badge/fond) au-dessus de "Bienvenue",
     formulaire limité en largeur (`max-w-md`) et remonté vers le haut (`justify-start`, pas
     centré verticalement).
   - **Plusieurs tentatives de style radicalement différent ont été essayées puis explicitement
     rejetées par l'utilisateur** ("je ne veux pas ce modèle") : carte unique fond marine plein
     cadre avec champs en pilule, formulaire réécrit sur le modèle "sign-up-page" avec icônes
     Mail/Lock — toutes annulées, ne pas les reproposer sans qu'il le redemande explicitement.
   - **À faire en reprenant** : pousser le commit `5d077f5` (et tous ceux qui précèdent, non
     poussés non plus) vers `origin/master`, puis redéployer en prod et faire confirmer par
     l'utilisateur que le dernier état lui convient — la session s'est arrêtée en pleine itération,
     pas de validation finale explicite reçue.

## Ce qui a été fait (session du 13/10/2026)

### Chasse aux bugs post-fusion SPA
- **Sélecteur de magasin global manquant sur la sidebar classique** (`e681ad0`) — `Topbar.tsx`
  n'avait jamais porté le bouton `#global-shop-selector-btn` depuis la création du shell (seul
  `NotchNav.tsx` l'avait) ; un compte ADMIN/SUPERVISOR en mode sidebar classique n'avait donc aucun
  moyen de changer de magasin.
- **"Aucun magasin assigné à ce compte" affiché à tort pour un SUPERVISOR au Tableau de bord**
  (`5ab7ba1`) — `ConformityTrendChart` se montait avant que le sélecteur de magasin global n'ait
  résolu un magasin par défaut, partait donc sans `shop=`, backend répondait 400, erreur restée
  figée à l'écran. Protégé par la même garde que les autres cartes KPI de la page.
- Investigation complète du rôle SUPERVISOR (compte de test créé/supprimé) : backend et reste du
  frontend fonctionnent correctement, pas d'autre bug de code trouvé sur ce rôle.

### Page de connexion — historique des itérations (pour contexte, pas à refaire)
Dans l'ordre : palette noir → marine/ambre, alignement décalé corrigé, plusieurs cycles
agrandissement/rétrécissement de la carte et des champs, plein écran puis retour à une carte
centrée, DotMap → image Tiny-man.jpg → DotMap à nouveau (coordonnées rendues proportionnelles au
panneau, fixant un bug où les trajets animés restaient figés dans un coin), logo déplacé du panneau
gauche vers le panneau droit, modèle "fond marine plein cadre" et modèle "sign-up-page avec icônes"
tous deux essayés puis rejetés. Voir le log git détaillé (`git log --oneline -- 
frontend/react-app-shell/src/pages/Login/`) si besoin de retracer une étape précise.

## Ce qui N'A PAS été fait / reste en suspens

1. **Voir "En cours" ci-dessus** — bug des 117 articles à stock aberrant non traité, commits de la
   page de connexion non poussés sur `origin/master`.
2. **"Guide d'utilisation"** — contenu pour un magasin à rédiger avec des captures d'écran que
   l'utilisateur doit fournir — toujours pas reçues à ce jour.
3. Points hérités des passations antérieures non re-mentionnés ici : considérés clos sauf nouvelle
   observation — voir historique git si besoin de détail.

## Repères techniques utiles pour la suite

- Shell unifié : `frontend/react-app-shell/` — toutes les pages y sont, plus aucune route
  `location ^~ /<page>-app/` dans `nginx.conf`.
- Métriques précision IA : `backend/src/services/proposalService.js` (~2806-2919, agrégation
  MAE/Bias/WAPE), `backend/src/jobs/predictionOutcomeJob.js` (job `AIPredictionOutcome`). Modèle
  `AIPrediction` a DEUX champs de quantité à ne pas confondre : `predictedWeeklyDemand` (vraie
  prévision de vente) vs `predictedQuantity` (quantité à commander, inclut stock de sécurité —
  toujours plus grande).
- Page de connexion : `frontend/react-app-shell/src/pages/Login/SignIn.tsx` +
  `components/DotMap.tsx` (animation canvas, routes maintenant en coordonnées fractionnaires 0-1
  pour s'adapter à la taille réelle du panneau — ne jamais revenir à des coordonnées pixel fixes).
- Sélecteur de magasin global : `frontend/assets/js/global-shop-selector.js` (script vanilla
  partagé), rattaché aux composants React via `window.reassortRenderShopSelector()` appelé dans un
  `useEffect` au montage (même pattern que la cloche de notifications) — tout nouveau composant qui
  a besoin du sélecteur doit reproduire ce rattachement, sinon le bouton reste invisible.
- Déploiement serveur de prod : Dokploy, accès terminal via conteneur backend (`cd /app`). Rebuild
  standard côté sandbox local : `docker compose build <service> && docker compose up -d
  --force-recreate <service>` depuis `/home/youssef/Documents/REASSORT_AUTO`. Bouton "Kill Build"
  (page Deployments du service dans Dokploy) pour annuler un déploiement en cours trop lent.
- MCP Claude in Chrome resté déconnecté toute la session — vérifications visuelles faites via
  Puppeteer + JWT signé manuellement en début de session, puis uniquement via captures d'écran
  collées par l'utilisateur depuis son propre navigateur pour tout le travail sur `/login`.
