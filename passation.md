# Passation — mise à jour du 13/10/2026

Remplace l'ancienne passation du 12/10/2026 (tous ses points ont depuis été traités, sauf mention
contraire ci-dessous). Contexte de la session du 13/10 : fin du chantier de fusion SPA (20 apps →
une seule, **terminé**), une série de corrections visuelles/UX post-fusion, un système de version
dynamique piloté depuis Paramètres, et une investigation en cours sur des métriques de précision IA
manifestement fausses (voir section "En cours").

## ⚠️ Piège récurrent à vérifier en premier à chaque nouvelle session

**Plusieurs clés `SystemConfig` sont éditables depuis Paramètres et donc stockées en base** — une
fois qu'une ligne existe pour une clé, elle **prime toujours** sur le défaut codé en dur
(`ENV_FALLBACK`, `systemConfigService.js`). Modifier le code et déployer **ne change rien** tant que
la ligne en base n'est pas aussi mise à jour ou supprimée.
```
node -e "const { PrismaClient } = require('@prisma/client'); const prisma = new PrismaClient(); (async () => { const row = await prisma.systemConfig.findUnique({ where: { key: '<CLE>' } }); console.log(row ? row.value.length + ' caractères en base' : 'aucune ligne, défaut du code appliqué'); })();"
```

## En cours (à reprendre en premier)

1. **Bug de précision des prévisions IA — cause racine trouvée, correction partielle appliquée,
   investigation à poursuivre demain.**

   Point de départ : l'utilisateur a remarqué des chiffres absurdes sur "Précision des prévisions
   IA" (Tableau de bord) — 91% de rejet, biais -86/-88, WAPE > 3000%, alors que "Confiance IA"
   affichait 80%, une combinaison qui ne tient pas debout.

   **Deux bugs distincts trouvés, un seul corrigé pour l'instant :**

   a) ✅ **Corrigé (commit à faire)** — `backend/src/jobs/predictionOutcomeJob.js` comparait les
      ventes réelles à `prediction.predictedQuantity` (la quantité à **commander**, qui inclut
      volontairement le stock de sécurité + le rattrapage du stock/commandes en cours — donc
      toujours bien plus grande que les ventes attendues) au lieu de
      `prediction.predictedWeeklyDemand` (la vraie prévision de vente, déjà stockée sur chaque
      `AIPrediction` mais jamais lue par ce job). Corrigé pour comparer au bon champ. Un script de
      backfill a aussi recalculé les ~9836 lignes `AIPredictionOutcome` déjà existantes avec la
      bonne formule (exécuté manuellement par l'utilisateur, confirmé "9836 ligne(s) recalculée(s)").

   b) ❌ **PAS corrigé — cause racine réelle des chiffres aberrants, à traiter demain.** Après le
      fix (a), les chiffres globaux ont à peine bougé (-87.7 / 3215% WAPE au lieu de -86.2 / 3184%)
      — preuve que le vrai problème n'est pas le champ comparé mais que `predictedWeeklyDemand`
      lui-même est aberrant pour certains articles. Creusé jusqu'à la source : l'EAN `100083225`
      ("LAIT PDR ENTIER SHT 15G BNET RGE", magasin `4872a5ae-ec51-4323-b249-0b640fe79718`) a une
      `predictedWeeklyDemand` calculée à **231777 unités/semaine** pour un article qui n'a **aucune
      vente historique enregistrée** (`SalesLine` vide). Remonté jusqu'à `ProductCache.stock` pour
      cet article : **26708** (voire plus sur d'autres lignes) — une valeur de stock qui contamine
      le calcul de la prévision en amont.
      Vérifié que ce n'est pas un cas isolé : **117 articles** ont un `ProductCache.stock > 5000`
      **ET** zéro vente historique — alignement à 100% sur l'échantillon testé, donc pattern
      systémique, pas un outlier. Hypothèse la plus probable : bug de synchronisation RPOS pour ces
      références (stock remonté dans la mauvaise unité, ou flux cassé pour ces articles précis) —
      pas un bug du calcul IA lui-même.
      **Prochaine étape proposée à l'utilisateur, pas encore faite** : sortir la liste complète des
      117 (EAN, magasin, stock) pour qu'il vérifie dans RPOS/en magasin si quelques exemples
      correspondent à la réalité physique ou sont clairement faux — déterminera si le fix est côté
      sync RPOS (exclure/filtrer ces stocks aberrants) ou côté affichage uniquement.

   **À faire en reprenant demain** :
   - Committer le fix (a) — `backend/src/jobs/predictionOutcomeJob.js`, pas encore commité à la fin
     de la session du 13/10.
   - Sortir la liste des 117 articles (EAN, magasin, stock) pour vérification terrain par
     l'utilisateur.
   - Décider si on filtre ces stocks aberrants des calculs de prévision en attendant un vrai fix de
     synchro RPOS, ou si on corrige la source.

## Ce qui a été fait (session du 13/10/2026)

### Chantier de fusion SPA — terminé
Les 20 apps React indépendantes sont maintenant toutes fusionnées dans `react-app-shell` (vagues 1
à 5 du plan `pure-singing-willow.md`, toutes marquées terminées). Reste de cette session : chasse
aux régressions visuelles post-fusion via Chrome headless + JWT de test (MCP Chrome interactif
resté déconnecté toute la session) :
- Sidebar invisible (collision Tailwind v4 `.collapse` vs Bootstrap `.collapse`), loading overlay
  qui restait affiché ~4s, highlight ambre de l'item actif absent, notch nav reconstruit fidèlement
  (design "floating island"), sélecteur de magasin et cloche de notifications non fonctionnels dans
  le shell (scripts vanilla jamais réattachés après montage React — pattern
  `window.reassortRenderXxx()` ajouté pour les deux), icônes sidebar actives en bloc plein au lieu
  d'un contour (règle CSS `fill` écrasant les SVG lucide-react, supprimée), couleurs Paramètres et
  site entier passées de noir/gris strict à marine/ambre (`--bs-primary` etc.), page Destinataires
  email (rouge trop agressif → gris neutre + ambre), `<select>` Génération natif remplacé par
  `CompactDropdown.tsx`, widget IA flottant reconstruit en React (`FloatingAiWidget.tsx`, masqué sur
  `/login` et `/ai-assistant`).

### Système de version dynamique
Remplace un premier essai (auto-incrément à chaque commit via hook Git) explicitement refusé par
l'utilisateur ("je veux que si je suis sûr que c'est bon je met à jour la valeur sur le UI"). Version
courante éditable manuellement dans Paramètres > Réassort (`SiteBrandingSection.tsx`), stockée en
base (`SystemConfig` clé `APP_VERSION`), lue par le shell via `useAppVersion()`. Pop-up "nouvelle
version disponible" au chargement (`AppVersionNoticeModal.tsx`) avec notes de version saisies
manuellement (`APP_VERSION_NOTES`), affichage en cartes encadrées avec tiret ambre, vu/pas-vu suivi
par utilisateur en `localStorage`. Garde-fou ajouté : confirmation si l'admin sauvegarde une version
sans avoir rempli les notes.

### Libellés français des métriques IA (Tableau de bord)
"MAE"/"WAPE"/"Biais" remplacés par "Erreur moyenne (en unités)"/"Tendance à sous/sur-estimer"/
"Erreur en % des ventes" dans `AllShopsView.tsx` — affichage uniquement, pas de changement de
calcul (le changement de calcul est le point "En cours" ci-dessus, découvert après coup en
expliquant ces mêmes métriques à l'utilisateur).

## Ce qui N'A PAS été fait / reste en suspens

1. **Voir section "En cours" ci-dessus** — bug (b) non corrigé (stocks aberrants pollant les
   prévisions sur 117 articles), fix (a) pas encore commité.
2. **"Guide d'utilisation"** — contenu pour un magasin à rédiger avec des captures d'écran que
   l'utilisateur doit fournir ("apres je vais ajouter les capture") — toujours pas reçues en fin de
   session du 13/10.
3. Points hérités de la passation du 12/10 non re-mentionnés ici (chatbot, tokens Gemini, etc.) :
   considérés clos sauf nouvelle observation — voir historique git si besoin de détail.

## Repères techniques utiles pour la suite

- Shell unifié : `frontend/react-app-shell/` — toutes les pages y sont désormais, plus aucune route
  `location ^~ /<page>-app/` dans `nginx.conf`.
- Métriques précision IA : `backend/src/services/proposalService.js` (~2806-2919, agrégation
  MAE/Bias/WAPE), `backend/src/jobs/predictionOutcomeJob.js` (job qui crée les lignes
  `AIPredictionOutcome`, contient le fix (a) de cette session), modèle `AIPrediction` a DEUX champs
  de quantité à ne pas confondre : `predictedWeeklyDemand` (vraie prévision de vente) vs
  `predictedQuantity` (quantité à commander, inclut stock de sécurité — toujours plus grande).
- Script de backfill utilisé (ponctuel, dans le scratchpad de session, pas committé) : recalcule
  `forecastError`/`absoluteError`/`percentageError` de toutes les lignes `AIPredictionOutcome`
  existantes à partir de `predictedWeeklyDemand`. À reproduire si un futur fix nécessite un nouveau
  recalcul de l'historique.
- Système de version : `backend/src/services/systemConfigService.js` (clés `APP_VERSION`/
  `APP_VERSION_NOTES`), `backend/src/routes/publicAssets.js` (routes `/app-version`),
  `frontend/react-app-shell/src/shared/hooks/useAppVersion.ts` /`useAppVersionNotice.ts`.
- Déploiement serveur de prod : Dokploy, accès terminal via conteneur backend (`cd /app`). Rebuild
  standard côté sandbox local : `docker compose build <service> && docker compose up -d
  --force-recreate <service>` depuis `/home/youssef/Documents/REASSORT_AUTO`.
- MCP Claude in Chrome déconnecté toute la session du 13/10 — vérifications visuelles faites via
  Puppeteer + JWT signé manuellement, ou captures d'écran collées par l'utilisateur depuis son
  propre navigateur.
