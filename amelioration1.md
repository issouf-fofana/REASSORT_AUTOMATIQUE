# Mission Claude Code — Évolution architecture Chatbot IA REASSORT_AUTO

## 1. Objectif

Faire évoluer l'architecture actuelle du chatbot IA de REASSORT_AUTO vers une architecture hybride **Local PostgreSQL + RPOS Live**, sans casser les fonctionnalités existantes.

### Principe fondamental

* Les données historiques et analytiques restent en PostgreSQL local.
* Les données temps réel critiques, notamment le stock actuel, restent interrogées directement depuis RPOS.
* Ne PAS synchroniser l'intégralité du catalogue RPOS.
* Ne PAS transformer le projet en copie complète de RPOS.
* Le LLM ne doit jamais accéder directement à PostgreSQL ou à RPOS.
* Le LLM reçoit uniquement les résultats JSON produits par les tools.
* Conserver le routage déterministe actuel par regex/mots-clés.
* Le LLM reste un fallback de routage et le générateur de réponse naturelle.

Architecture cible :

```text
                         ┌──────────────────┐
                         │       RPOS       │
                         └────────┬─────────┘
                                  │
                    ┌─────────────┴─────────────┐
                    │                           │
              Synchronisation              Requêtes LIVE
                    │                           │
                    ▼                           ▼
          ┌──────────────────┐         ┌──────────────────┐
          │ PostgreSQL local │         │    RPOS API      │
          │                  │         │                  │
          │ SalesLine        │         │ Stock actuel     │
          │ Proposals        │         │ Stock magasins   │
          │ Predictions      │         │ Mouvements       │
          │ Orders           │         │ données temps réel│
          │ Anomalies        │         └────────┬─────────┘
          └────────┬─────────┘                  │
                   │                            │
                   └──────────────┬─────────────┘
                                  ▼
                           Chatbot Tools
                                  │
                                  ▼
                            JSON structuré
                                  │
                                  ▼
                                LLM
                                  │
                                  ▼
                             Réponse UI
```

---

# 2. Ne pas faire de réplication complète

IMPORTANT :

NE PAS créer un job qui récupère les 100 000 / 200 000 / 500 000 articles RPOS simplement pour alimenter le chatbot.

Le système doit fonctionner avec :

```text
Données analytiques
        ↓
PostgreSQL local

Données temps réel
        ↓
RPOS Live
```

Le PostgreSQL local doit être considéré comme un **read model métier optimisé**, pas comme une copie de RPOS.

---

# 3. Classification des données

Créer une documentation/code centralisant la classification suivante.

## 3.1 Données locales

Ces données doivent rester dans PostgreSQL :

### Ventes

* SalesLine
* historique des ventes
* CA
* quantités vendues
* ventes par article
* ventes par magasin
* ventes par rayon
* Pareto
* tendances
* périodes historiques

### Réassort

* Proposal
* ProposalLine
* historique des propositions
* quantités proposées
* quantités validées
* corrections utilisateur
* historique des décisions

### IA

* AIPredictionOutcome
* précision
* historique des prédictions
* anomalies
* métriques du modèle

### Commandes

* données locales déjà synchronisées
* historiques nécessaires aux analyses

Ces tools doivent continuer à utiliser PostgreSQL/Prisma.

---

# 4. Données temps réel

Les données suivantes doivent rester RPOS Live lorsque la question demande une valeur actuelle :

## Stock

```text
getArticleStock
getArticleStockAllShops
getStoreStock
```

Exemples :

> Quel est le stock de Coca 1.5L ?

> Quel est le stock de cet article dans tous les magasins ?

Ces questions doivent interroger RPOS directement.

NE PAS utiliser une copie locale du stock comme vérité principale.

---

# 5. Pourquoi le stock reste LIVE

Le stock est une donnée très volatile.

Exemple :

```text
08:00 → stock 100
08:05 → vente 20
08:06 → vente 10
08:07 → stock 70
```

Une synchronisation toutes les 15 minutes pourrait retourner une information obsolète.

Donc :

```text
Question stock
     ↓
RPOS Live
     ↓
Stock actuel
```

Le système peut éventuellement conserver une dernière valeur connue uniquement pour :

* diagnostic ;
* observabilité ;
* fallback technique ;
* affichage de l'heure de dernière consultation.

Mais cette valeur ne doit jamais être présentée comme le stock actuel si RPOS n'a pas été interrogé.

---

# 6. Données hybrides

Certaines données peuvent être local + RPOS.

## Fiche article

```text
getArticleDetails
```

Ne pas synchroniser tout le catalogue.

Comportement :

```text
Question
   ↓
EAN connu ?
   │
   ├── oui → RPOS
   │
   └── non → searchArticlesByName → RPOS
```

Optionnellement, conserver un petit cache des articles déjà consultés.

Ce cache ne doit pas devenir une synchronisation massive.

---

# 7. Prix

Pour le prix actuel, privilégier RPOS si l'information doit être exacte et actuelle.

Pour l'historique des prix :

```text
getPriceChangeHistory
```

RPOS peut rester la source principale.

Si le volume et la latence deviennent problématiques, envisager plus tard une synchronisation ciblée de l'historique.

NE PAS faire cette optimisation dans la première phase sans mesure réelle.

---

# 8. Mouvements de stock

Pour :

```text
getStockMoveHistory
getStockMoveHistoryAllShops
```

Conserver RPOS Live dans un premier temps.

La priorité est de conserver la donnée réelle.

Ne pas répliquer tous les mouvements de tous les articles de tous les magasins sans mesurer le volume.

---

# 9. Règle de décision pour chaque Tool

Créer une règle claire :

```text
TOOL
 ↓
Cette donnée est-elle historique/analytiquement stable ?
 ↓
OUI → PostgreSQL local
 ↓
NON
 ↓
Cette donnée doit-elle être exacte à l'instant T ?
 ↓
OUI → RPOS Live
```

Ne pas laisser chaque développeur décider différemment.

Documenter cette classification dans le code.

---

# 10. Optimisation de getArticleStockAllShops

C'est actuellement un point de latence important.

Situation actuelle :

```text
getArticleStockAllShops
        ↓
Promise.all()
        ↓
RPOS magasin 1
RPOS magasin 2
RPOS magasin 3
...
RPOS magasin N
```

Ne pas supprimer le temps réel.

Mais améliorer la stratégie.

## Étape 1

Mesurer précisément :

* nombre de magasins ;
* temps moyen par requête ;
* p50 ;
* p95 ;
* p99 ;
* taux d'erreur ;
* timeout ;
* nombre de magasins réellement autorisés.

## Étape 2

Conserver la parallélisation si le nombre de magasins est raisonnable.

## Étape 3

Ajouter timeout individuel par magasin.

Exemple conceptuel :

```javascript
Promise.race([
    getStockFromRpos(shop, ean),
    timeout(5000)
])
```

Un magasin lent ne doit pas bloquer tout le résultat.

## Étape 4

Retourner explicitement les magasins en erreur.

Exemple :

```json
{
  "ean": "1234567890123",
  "results": [...],
  "failedShops": [
    {
      "shopId": "035",
      "reason": "timeout"
    }
  ]
}
```

NE JAMAIS transformer une erreur RPOS en stock `0`.

---

# 11. Ne jamais confondre "0" et "erreur"

C'est une règle critique.

```text
stock = 0
```

signifie :

> RPOS a répondu que le stock est zéro.

Alors que :

```text
RPOS timeout
```

signifie :

> Le stock est inconnu.

Ces deux situations doivent être différentes dans le JSON.

Exemple :

```json
{
  "stock": 0,
  "source": "rpos",
  "status": "success"
}
```

vs :

```json
{
  "stock": null,
  "source": "rpos",
  "status": "timeout"
}
```

Le LLM ne doit jamais transformer `null + timeout` en `0`.

---

# 12. Ajouter la provenance des données

Tous les tools importants doivent retourner des métadonnées de provenance.

Exemple :

```json
{
  "data": {...},
  "source": "local",
  "generatedAt": "2026-10-07T08:50:00Z"
}
```

Pour RPOS :

```json
{
  "data": {...},
  "source": "rpos_live",
  "queriedAt": "2026-10-07T08:52:13Z"
}
```

Pour les outils hybrides :

```json
{
  "data": {...},
  "sources": [
    "local",
    "rpos_live"
  ],
  "queriedAt": "..."
}
```

---

# 13. Ajouter l'état de fraîcheur

Pour les données locales, permettre de connaître :

```text
lastSyncAt
dataAge
```

Exemple :

```json
{
  "source": "local",
  "lastSyncAt": "2026-10-07T08:45:00Z",
  "dataAgeMinutes": 12
}
```

Cela permettra au LLM de ne pas présenter une donnée locale ancienne comme une donnée temps réel.

---

# 14. Modifier le prompt système

Le prompt doit connaître la différence entre :

```text
source = local
```

et :

```text
source = rpos_live
```

Règles :

### Source RPOS Live

Le LLM peut présenter la donnée comme actuelle.

### Source locale

Le LLM doit respecter `lastSyncAt` si cette information est pertinente.

### Erreur RPOS

Le LLM doit dire que la donnée actuelle n'a pas pu être récupérée.

Il ne doit jamais inventer une valeur.

---

# 15. Exemple de comportement attendu

Question :

> Quel est le stock de l'article 1234567890123 ?

Pipeline :

```text
detectIntent
      ↓
getArticleStock
      ↓
RPOS LIVE
      ↓
{
  "ean": "...",
  "stock": 42,
  "source": "rpos_live"
}
      ↓
LLM
      ↓
"Le stock actuel est de 42 unités."
```

---

# 16. Exemple réassort

Question :

> Pourquoi proposes-tu de commander 120 unités ?

Pipeline :

```text
                    Question
                       │
           ┌───────────┴────────────┐
           ▼                        ▼
      PostgreSQL                 RPOS Live
           │                        │
    ventes historiques          stock actuel
    moyenne ventes              stock magasin
    prévision
    stock sécurité
    délai fournisseur
    proposition
           │                        │
           └───────────┬────────────┘
                       ▼
                  Tool Result
                       │
                       ▼
                      LLM
                       │
                       ▼
                   Explication
```

Le LLM explique alors la proposition avec les données réelles.

---

# 17. Ne pas créer un RAG vectoriel pour les données SQL

IMPORTANT :

Ne pas mettre les ventes, stocks et CA dans une base vectorielle simplement pour faire du RAG.

Pour :

> CA du magasin 050 sur 30 jours

utiliser SQL.

Pour :

> articles représentant 80 % du CA

utiliser SQL/Pareto.

Pour :

> stock actuel

utiliser RPOS.

Pour :

> Pourquoi cette quantité est proposée ?

utiliser les données structurées locales + RPOS + éventuellement RAG métier.

---

# 18. RAG futur

Préparer l'architecture pour pouvoir ajouter plus tard un RAG concernant :

* règles métier ;
* documentation ;
* procédures ;
* corrections humaines ;
* explications de décisions ;
* historique des corrections ;
* documentation fournisseurs ;
* documentation réassort.

Architecture :

```text
                 Question
                    │
          ┌─────────┴──────────┐
          ▼                    ▼
      SQL / Tools             RAG
          │                    │
          └─────────┬──────────┘
                    ▼
                   LLM
```

Mais ne pas implémenter une vectorisation massive dans cette phase si ce n'est pas nécessaire.

---

# 19. Optimiser les appels LLM

Conserver :

```text
Regex / règles
      ↓
Tool
```

avant tout appel LLM.

Le fallback :

```text
detectIntentViaLlm()
```

reste uniquement pour les formulations inconnues.

Même chose pour :

```text
resolveDateRangeViaLlm()
```

Ne pas appeler le LLM pour une date facilement détectable par regex.

---

# 20. Ne pas modifier la sécurité

Conserver impérativement :

```text
checkToolPermission()
isEanInUserScope()
```

et le principe fail-closed.

Chaque nouveau tool doit obligatoirement être ajouté à :

```text
TOOL_CAPABILITY
```

Aucun tool non déclaré ne doit être accessible.

Tester notamment :

* ADMIN ;
* SUPERVISOR ;
* DIRECTOR ;
* DEPARTMENT_HEAD ;
* SHELF_STOCKER ;
* utilisateur sans rôle ;
* utilisateur sans permission ;
* article hors rayon autorisé.

---

# 21. Ne pas casser le contexte conversationnel

Conserver :

```text
ARTICLE_SCOPED_TOOLS
AMBIGUOUS_SCOPE_TOOLS
DATE_SENSITIVE_TOOLS
```

et toutes les corrections déjà présentes.

Tester notamment :

```text
"Quel est le stock de l'article X ?"
"Et son CA ?"
```

mais aussi :

```text
"Quel est le stock de l'article X ?"
"Quel est le stock du magasin ?"
```

La deuxième question ne doit pas récupérer silencieusement l'EAN précédent.

---

# 22. Tests à ajouter

Créer une suite de tests automatisés pour :

## Stock

```text
stock actuel
stock zéro
RPOS timeout
RPOS erreur
article inconnu
magasin inconnu
tous magasins
```

## Données locales

```text
CA
ventes
Pareto
tendance
prévision
proposition
```

## Fraîcheur

```text
local récent
local ancien
absence de synchronisation
```

## Permissions

Tester chaque rôle.

## Contexte

Tester les questions successives.

## Questions composées

Tester :

```text
"Quel est le stock de X et son CA ?"
```

---

# 23. Observabilité

Ajouter des métriques/logs permettant de savoir :

```text
question
intent
tool
source
duration
rposDuration
dbDuration
llmDuration
totalDuration
success/error
```

Exemple :

```json
{
  "tool": "getArticleStock",
  "source": "rpos_live",
  "rposDurationMs": 820,
  "llmDurationMs": 2100,
  "totalDurationMs": 2950
}
```

Cela permettra de savoir précisément où se trouve la latence.

---

# 24. KPI à surveiller

Après implémentation, mesurer :

### Chatbot

* temps moyen de réponse ;
* p50 ;
* p95 ;
* p99.

### RPOS

* temps moyen ;
* timeout ;
* erreurs ;
* nombre d'appels par question.

### PostgreSQL

* temps moyen des queries ;
* queries lentes ;
* index manquants.

### LLM

* nombre d'appels ;
* coût ;
* temps moyen ;
* fallback routing rate.

Objectif :

```text
Questions analytiques
→ principalement PostgreSQL

Questions stock
→ RPOS Live

Questions inconnues
→ fallback LLM uniquement
```

---

# 25. Ordre d'implémentation

NE PAS tout modifier en une seule fois.

Faire les étapes suivantes.

## Phase 1 — Audit

Avant toute modification :

1. analyser `chatbotService.js`
2. analyser `chatbotToolsService.js`
3. analyser `salesSyncJob.js`
4. analyser le schéma Prisma
5. identifier exactement les tables locales existantes
6. identifier les appels RPOS existants
7. identifier les tools et leurs sources actuelles
8. ne modifier aucun comportement fonctionnel

Produire un rapport avant modification.

---

## Phase 2 — Classification

Créer une matrice :

```text
Tool
Source
Local / Live
Donnée temps réel ?
Fallback ?
Permission ?
```

Exemple :

```text
getRevenue
→ LOCAL

getSalesHistory
→ LOCAL

getParetoArticles
→ LOCAL

getArticleStock
→ RPOS LIVE

getArticleStockAllShops
→ RPOS LIVE

getArticleDetails
→ RPOS LIVE

getStockMoveHistory
→ RPOS LIVE
```

---

## Phase 3 — Provenance

Ajouter les métadonnées :

```text
source
queriedAt
lastSyncAt
dataAgeMinutes
status
```

sans modifier la logique métier.

---

## Phase 4 — Robustesse RPOS

Améliorer :

* timeout ;
* gestion des erreurs ;
* distinction zéro / erreur ;
* failedShops ;
* logs ;
* métriques.

---

## Phase 5 — Optimisation tous magasins

Mesurer puis optimiser :

```text
getArticleStockAllShops
getStockMoveHistoryAllShops
```

Ne pas modifier la concurrence sans benchmark.

---

## Phase 6 — Cache ciblé facultatif

Seulement si les mesures montrent que certaines données non temps réel sont trop lentes :

```text
ProductCache
PriceCache
```

avec TTL.

NE PAS créer de cache massif.

---

## Phase 7 — RAG métier

Seulement après stabilisation du reste.

Ajouter éventuellement :

```text
règles métier
historique corrections
documentation
```

dans une couche RAG séparée.

---

# 26. Contraintes absolues

Claude Code doit respecter ces règles :

1. Ne pas synchroniser tout le catalogue RPOS.
2. Ne pas synchroniser tout le stock.
3. Ne pas remplacer le stock RPOS Live par PostgreSQL.
4. Ne pas donner au LLM un accès direct à la DB.
5. Ne pas supprimer les permissions existantes.
6. Ne pas supprimer les regex existantes.
7. Ne pas supprimer le fallback LLM.
8. Ne pas changer les réponses fonctionnelles sans raison.
9. Ne pas ajouter un nouveau modèle Prisma sans justification.
10. Ne pas ajouter Redis/vector DB sans nécessité démontrée.
11. Ne pas optimiser sur une hypothèse : mesurer d'abord.
12. Toute optimisation doit être réversible.
13. Tout changement important doit avoir des tests.
14. Ne jamais convertir une erreur RPOS en valeur `0`.
15. Une donnée locale doit indiquer sa fraîcheur lorsqu'elle est pertinente.

---

# 27. Résultat final attendu

L'architecture finale doit être :

```text
                         USER
                           │
                           ▼
                    Intent Detection
                           │
                           ▼
                    Parameter Extraction
                           │
                           ▼
                      Permissions
                           │
                           ▼
                     Tool Selection
                           │
             ┌─────────────┴─────────────┐
             │                           │
             ▼                           ▼
      PostgreSQL LOCAL              RPOS LIVE
             │                           │
             │                    stock actuel
             │                    données temps réel
             │
       ventes historiques
       CA
       Pareto
       propositions
       prédictions
       anomalies
       commandes
             │                           │
             └─────────────┬─────────────┘
                           ▼
                     Tool Result JSON
                           │
                           ▼
                         LLM
                           │
                           ▼
                       Réponse
```

## Principe final

**LOCAL pour l'historique et l'analyse.**

**RPOS LIVE pour la vérité temps réel.**

**Pas de réplication massive.**

**Pas de RAG pour les données structurées.**

**LLM uniquement après récupération des données.**

Avant de coder, inspecter le repo et produire la matrice actuelle `Tool → Source → Latence → Permission → Donnée`, puis proposer les modifications minimales nécessaires. Ne commencer les modifications qu'après avoir identifié précisément les fichiers et fonctions concernés.


 
-----------------commmande CD et CC-------------------
# Évolution du module de génération des commandes — Séparation CC/CD et gestion par fournisseur

## 1. Contexte et fonctionnement actuel

Actuellement, lors de la génération des commandes, les commandes LC et LD sont regroupées dans la même vue. Les articles sont répartis dans les différents secteurs, départements et rayons, mais les commandes centrales et directes sont mélangées.

De plus, lorsqu'un même fournisseur est associé à plusieurs rayons, le système peut générer plusieurs commandes pour ce fournisseur dans un même magasin. Par exemple, une commande est créée pour les articles du rayon Liquide, une autre pour les articles du rayon Épicerie salée et une troisième pour les articles du rayon Entretien, alors que tous ces articles appartiennent au même fournisseur.

Je souhaite faire évoluer ce fonctionnement pour permettre une meilleure organisation des propositions, une sélection flexible des fournisseurs et une validation globale des commandes.

**Attention : il faut conserver les fonctionnalités existantes qui ne sont pas concernées par cette évolution. En particulier, la logique métier des commandes LC ne doit pas être modifiée pour le moment.**

## 2. Objectifs de l'évolution

Les objectifs sont les suivants :

1. Séparer l'affichage des commandes centrales et des commandes directes.
2. Ajouter un filtre par fournisseur dans la vue de génération.
3. Afficher tous les articles associés au fournisseur sélectionné, classés par secteur, département et rayon.
4. Permettre de modifier le fournisseur d'un article lorsqu'il est disponible chez plusieurs fournisseurs.
5. Permettre de valider toutes les propositions d'un fournisseur depuis sa racine, sans devoir valider chaque rayon séparément.
6. Générer une seule commande par fournisseur et par magasin pour les commandes directes, contenant tous les articles retenus, quels que soient leurs secteurs, départements et rayons.
7. Préserver les règles actuelles de calcul des quantités, de validation et de traitement des commandes.

---

## 3. Séparation des commandes centrales et directes

Dans la vue **Génération des commandes**, ajouter un filtre permettant de choisir le type de commande.

Les correspondances sont les suivantes :

- **CD — Commande directe :** correspond aux commandes LD.
- **CC — Commande centrale :** correspond aux commandes LC.

### Fonctionnement attendu

Lorsque l'utilisateur sélectionne CD, seuls les articles destinés aux commandes LD doivent être affichés.

Lorsque l'utilisateur sélectionne CC, seuls les articles destinés aux commandes LC doivent être affichés.

Les articles doivent être filtrés correctement dans tous les niveaux de l'arborescence : secteurs, départements et rayons. Il ne doit pas être possible de mélanger les articles CC et CD dans le même affichage filtré.

Le filtre doit agir sur les données réellement affichées et sur les articles concernés par les opérations de validation. Il ne doit pas simplement masquer visuellement certains articles tout en les laissant inclus dans la génération.

### Règle impérative concernant les LC

Pour le moment, aucune modification de la logique métier des commandes LC n'est demandée.

Le travail consiste uniquement à isoler leur affichage de celui des LD et à ajouter les fonctionnalités nécessaires sans modifier leur fonctionnement actuel de calcul, de validation ou de traitement.

---

## 4. Ajouter un filtre par fournisseur

Dans la vue Génération des commandes, ajouter un filtre permettant de sélectionner un fournisseur.

Ce filtre doit fonctionner avec le filtre du type de commande.

### Fonctionnement attendu

Par défaut, lorsque les filtres ne sont pas renseignés, l'utilisateur conserve l'affichage global correspondant au fonctionnement actuel, sous réserve de la séparation entre CC et CD.

Lorsqu'un fournisseur est sélectionné, le système doit afficher tous les articles éligibles à la génération pour ce fournisseur, en fonction du type de commande choisi.

Par exemple, si l'utilisateur sélectionne :

- Type de commande : CD.
- Fournisseur : SATOCI.

Le système doit afficher tous les articles pouvant être commandés auprès de SATOCI pour le magasin concerné, qu'ils appartiennent au secteur Liquide, au département Épicerie salée, au rayon Entretien ou à d'autres secteurs et rayons.

Si l'utilisateur sélectionne un autre fournisseur, la liste doit s'actualiser pour afficher les articles correspondants à ce nouveau fournisseur.

### Organisation de l'affichage

Les articles doivent conserver leur classement hiérarchique existant :

- Secteur.
  - Département.
    - Rayon.
      - Articles proposés.

Le filtre fournisseur ne doit pas supprimer cette organisation. Il doit uniquement limiter les articles affichés aux articles correspondant au fournisseur sélectionné.

L'utilisateur doit ainsi pouvoir consulter les articles par secteur et par rayon tout en travaillant sur un fournisseur précis.

---

## 5. Permettre de modifier le fournisseur d'un article

Un même article peut être disponible chez plusieurs fournisseurs. Le système doit permettre de choisir un fournisseur différent de celui actuellement associé à l'article, lorsque plusieurs fournisseurs sont autorisés pour cet article.

### Exemple

Un article est initialement associé au fournisseur SATOCI, mais le magasin souhaite le commander auprès d'un autre fournisseur disponible dans le référentiel.

L'utilisateur doit pouvoir :

1. Consulter le fournisseur actuellement associé à l'article.
2. Consulter les autres fournisseurs disponibles pour cet article.
3. Sélectionner le fournisseur souhaité.
4. Conserver la quantité proposée ou la modifier selon les règles et fonctionnalités existantes.
5. Retrouver cet article dans la commande du fournisseur finalement choisi.

### Règles de gestion

Le fournisseur choisi doit être réellement autorisé pour l'article concerné.

Le changement de fournisseur doit être pris en compte avant la génération de la commande.

Si un article initialement rattaché à SATOCI est réaffecté à un autre fournisseur, il ne doit plus être intégré à la commande SATOCI pour cette génération. Il doit être intégré à la commande du nouveau fournisseur.

Le changement doit être appliqué de manière cohérente à l'affichage, aux regroupements et aux données utilisées lors de la génération.

**Important :** le changement de fournisseur effectué pour une commande ne doit pas modifier automatiquement le fournisseur principal de l'article dans le référentiel permanent. Il s'agit d'un choix effectué pour la commande en cours, sauf si une fonctionnalité distincte de modification du référentiel est explicitement prévue.

Le système doit également conserver une trace cohérente du fournisseur retenu pour chaque article dans la commande générée.

---

## 6. Organiser les articles par fournisseur tout en conservant les secteurs et les rayons

Lorsque l'utilisateur sélectionne un fournisseur, tous les articles éligibles associés à ce fournisseur doivent être regroupés dans son espace de génération.

Cependant, ils ne doivent pas être affichés dans une liste désorganisée.

Le classement par secteur, département et rayon doit être conservé pour faciliter la consultation et la vérification des propositions.

### Exemple : fournisseur SATOCI

Supposons que les propositions concernent les articles suivants :

- Secteur Liquide : 12 articles.
- Secteur Épicerie salée : 18 articles.
- Secteur Entretien : 7 articles.

Dans l'interface, ces articles restent répartis dans leurs secteurs, départements et rayons respectifs.

L'utilisateur peut ouvrir chaque niveau pour consulter les articles et leurs quantités proposées.

Cependant, ces différents niveaux ne doivent plus entraîner la création de commandes distinctes pour SATOCI.

**L'organisation des articles est hiérarchique pour la consultation, mais la validation et la génération doivent pouvoir se faire globalement au niveau du fournisseur.**

---

## 7. Ajouter une validation globale à la racine du fournisseur

C'est l'un des points essentiels de cette évolution.

Lorsque l'utilisateur se trouve à la racine d'un fournisseur, il doit disposer d'une action permettant de valider l'ensemble des propositions de commande de ce fournisseur pour le magasin concerné.

Par exemple, un bouton intitulé :

**« Valider toutes les propositions »**

Cette action doit permettre de prendre en compte les articles éligibles de tous les secteurs, départements et rayons de ce fournisseur, sans obliger l'utilisateur à ouvrir chaque rayon et à valider les articles séparément.

### Fonctionnement de la validation globale

1. L'utilisateur sélectionne le type de commande.
2. Il sélectionne le fournisseur souhaité.
3. Le système affiche tous les articles proposés pour ce fournisseur, classés par secteur, département et rayon.
4. L'utilisateur consulte les propositions et effectue, si nécessaire, les modifications autorisées, notamment le changement de fournisseur d'un article ou l'ajustement des quantités.
5. Depuis la racine du fournisseur, il déclenche la validation globale.
6. Le système récupère tous les articles éligibles appartenant effectivement à ce fournisseur pour le magasin concerné.
7. Le système génère une seule commande contenant tous les articles retenus.
8. La commande conserve les informations nécessaires au traitement ultérieur : articles, quantités, fournisseur, magasin et autres données déjà utilisées par le système.

La validation globale doit porter uniquement sur le fournisseur, le magasin et le type de commande concernés. Elle ne doit pas valider les propositions d'un autre fournisseur ni mélanger les commandes CC et CD.

### Attention à la portée de la validation

La validation globale ne doit pas se limiter aux articles actuellement visibles à l'écran si certains secteurs ou rayons sont repliés dans l'arborescence.

Elle doit récupérer toutes les propositions éligibles du fournisseur concerné, y compris les articles situés dans les niveaux qui ne sont pas ouverts visuellement.

En revanche, les articles explicitement exclus, non éligibles ou réaffectés à un autre fournisseur ne doivent pas être inclus.

Si l'utilisateur a la possibilité de sélectionner individuellement les articles à commander, la validation globale doit respecter cette sélection : elle porte sur toutes les propositions éligibles retenues, et non sur des articles que l'utilisateur aurait explicitement exclus.

---

## 8. Générer une seule commande par fournisseur et par magasin

Pour les commandes directes CD/LD, le système doit regrouper tous les articles retenus en fonction du fournisseur final choisi et du magasin concerné.

Le regroupement doit être indépendant du secteur, du département et du rayon.

### Exemple détaillé

Le magasin A dispose des propositions suivantes pour SATOCI :

| Secteur ou rayon | Nombre d'articles proposés |
|---|---:|
| Liquide | 12 |
| Épicerie salée | 18 |
| Entretien | 7 |
| **Total** | **37** |

Lorsque l'utilisateur valide les propositions de SATOCI à la racine, le système doit créer une seule commande SATOCI pour le magasin A, contenant les 37 articles retenus, sous réserve de leur éligibilité.

Il ne doit pas créer une commande pour Liquide, une autre pour Épicerie salée et une troisième pour Entretien.

### Exemple avec plusieurs fournisseurs

Pour le même magasin :

- SATOCI : articles Liquide, Épicerie salée et Entretien.
- Fournisseur B : articles Hygiène et Liquide.
- Fournisseur C : articles d'autres rayons.

Le résultat attendu est :

- Une commande SATOCI contenant tous ses articles retenus.
- Une commande pour le fournisseur B contenant tous ses articles retenus.
- Une commande pour le fournisseur C contenant tous ses articles retenus.

Chaque commande regroupe les articles du fournisseur concerné, même lorsqu'ils proviennent de plusieurs rayons.

### Règle de regroupement

Pour les commandes directes, la clé de regroupement doit correspondre au minimum à :

**Magasin + fournisseur final + opération de génération concernée.**

Le type de commande doit également être respecté : une commande CC ne doit jamais être regroupée avec une commande CD.

Deux magasins différents doivent toujours conserver des commandes distinctes, même lorsqu'ils commandent auprès du même fournisseur.

---

## 9. Déroulement fonctionnel complet

Le fonctionnement final attendu est le suivant :

### Étape 1 — Choisir le type de commande

L'utilisateur sélectionne CD pour les commandes directes ou CC pour les commandes centrales.

### Étape 2 — Sélectionner le fournisseur

L'utilisateur sélectionne le fournisseur pour lequel il souhaite consulter et traiter les propositions.

### Étape 3 — Consulter les propositions

Le système affiche tous les articles éligibles du fournisseur sélectionné, organisés par secteur, département et rayon.

### Étape 4 — Ajuster les propositions

L'utilisateur peut consulter les quantités proposées et effectuer les modifications autorisées.

Il peut également changer le fournisseur de certains articles lorsque d'autres fournisseurs sont disponibles et autorisés.

### Étape 5 — Valider depuis la racine

L'utilisateur clique sur l'action de validation globale du fournisseur.

Il n'est pas obligé de valider séparément les différents rayons.

### Étape 6 — Regrouper les articles

Le système vérifie le fournisseur final de chaque article et regroupe les articles retenus par fournisseur et par magasin.

### Étape 7 — Générer la commande

Pour les commandes directes, le système crée une seule commande par fournisseur et par magasin pour l'opération concernée, contenant tous les articles retenus de ce fournisseur.

### Étape 8 — Traiter la commande

Les commandes générées poursuivent le processus habituel de validation, d'envoi et de traitement, sans modification des règles métier existantes qui ne sont pas concernées par cette évolution.

---

## 10. Gestion des doublons et des erreurs

La nouvelle logique doit empêcher qu'une même opération de validation globale crée plusieurs commandes identiques pour le même fournisseur et le même magasin.

Si l'utilisateur clique plusieurs fois sur le bouton de validation, le système doit éviter de recréer les mêmes commandes ou de dupliquer les mêmes articles.

Le mécanisme doit tenir compte de l'état réel des propositions et des commandes déjà créées.

En cas d'échec pendant la génération, le système doit signaler clairement l'erreur et éviter de laisser un état incohérent avec des commandes partiellement créées sans possibilité de suivi.

Les règles existantes relatives aux quantités, à l'éligibilité, aux articles déjà commandés et à la validation doivent continuer à être respectées.

---

## 11. Contraintes techniques et précautions

Avant toute modification, analyser le fonctionnement actuel de la génération des commandes, la structure des données, les relations entre articles et fournisseurs, ainsi que les mécanismes existants de validation.

Il ne faut pas recréer un système parallèle si les mécanismes actuels peuvent être adaptés.

Les modifications doivent être cohérentes entre :

- L'interface de génération.
- Les filtres CC/CD et fournisseur.
- La sélection et la réaffectation des fournisseurs.
- La validation globale.
- Le regroupement des articles.
- La création effective des commandes.
- Les données enregistrées en base.
- Les mécanismes existants de validation, d'envoi et de suivi.

La logique de regroupement doit être appliquée au niveau du traitement de génération, et pas uniquement dans l'affichage. Masquer les rayons ou fusionner visuellement des articles ne suffit pas si le système continue à créer une commande par rayon en arrière-plan.

Les changements doivent également préserver les données historiques et le fonctionnement des commandes déjà générées.

---

## 12. Critères de validation de la fonctionnalité

La fonctionnalité sera considérée comme correcte lorsque les scénarios suivants auront été vérifiés :

1. En sélectionnant CD, seuls les articles des commandes directes LD sont affichés.
2. En sélectionnant CC, seuls les articles des commandes centrales LC sont affichés, sans modification de leur logique métier.
3. En sélectionnant SATOCI, tous ses articles éligibles apparaissent, classés par secteur, département et rayon.
4. En sélectionnant un autre fournisseur, seuls les articles correspondant à ce fournisseur apparaissent.
5. Un article pouvant être fourni par plusieurs fournisseurs peut être réaffecté à un autre fournisseur autorisé.
6. Après cette réaffectation, l'article est intégré à la commande du fournisseur choisi et non à celle du fournisseur initial.
7. La validation à la racine du fournisseur prend en compte tous les articles retenus, y compris ceux des secteurs et rayons repliés.
8. La validation globale de SATOCI génère une seule commande contenant ses articles retenus de tous les rayons concernés.
9. Deux fournisseurs différents génèrent des commandes distinctes.
10. Le même fournisseur dans deux magasins différents génère des commandes distinctes.
11. Une nouvelle validation ne provoque pas de doublons de commandes ou d'articles.
12. Les quantités proposées et les règles existantes de traitement sont préservées.
13. Les commandes LC continuent de fonctionner comme auparavant, hormis la séparation de leur affichage.

## Résultat final attendu

Je veux une vue de génération claire dans laquelle je peux choisir le type de commande, sélectionner un fournisseur, consulter ses articles classés par secteur et par rayon, changer si nécessaire le fournisseur d'un article, puis valider toutes les propositions depuis la racine du fournisseur.

Pour les commandes directes, le système doit ensuite générer une seule commande par fournisseur et par magasin, regroupant tous les articles retenus, quels que soient leurs secteurs, départements et rayons.

**L'objectif est de conserver une navigation détaillée par secteur et par rayon, tout en centralisant la validation et la génération au niveau du fournisseur, sans modifier la logique métier actuelle des commandes centrales.**