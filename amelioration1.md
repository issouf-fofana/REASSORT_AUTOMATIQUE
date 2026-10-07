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
