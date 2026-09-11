# 🤖 AI REPLENISHMENT PLATFORM

## Système intelligent de pilotage continu du réassort et de l'approvisionnement

---

# 1. Vision du projet

L'objectif du projet est de transformer le système actuel de réassort en une **plateforme intelligente de gestion continue des stocks et des commandes**, capable à terme de réaliser automatiquement le réassort des magasins.

Le système doit évoluer progressivement selon trois grandes étapes :

```text
PHASE 1
AI PILOT
IA propose
↓
Magasin valide
↓
Commande RPOS
↓
Le système observe le résultat

PHASE 2
AI SUPERVISED
IA propose
↓
Le système mesure sa fiabilité
↓
Certaines décisions peuvent être validées rapidement
↓
L'humain reste dans la boucle

PHASE 3
AI AUTOPILOT
IA analyse
↓
IA prédit
↓
IA contrôle sa confiance
↓
IA applique les règles de sécurité
↓
IA commande automatiquement
```

Le système doit donc être conçu dès maintenant pour permettre cette évolution.

---

# 2. Principe fondamental

Le système ne doit pas considérer une proposition comme une simple quantité calculée à un instant T.

Une proposition doit progressivement devenir une **décision vivante**, suivie dans le temps.

L'IA doit être capable de :

* observer les ventes ;
* observer les stocks ;
* observer les commandes ;
* analyser les tendances ;
* prévoir la demande ;
* détecter les anomalies ;
* proposer des commandes ;
* expliquer ses recommandations ;
* mesurer la qualité de ses propres prévisions ;
* apprendre de ses erreurs ;
* prendre progressivement plus d'autonomie lorsque suffisamment de données fiables sont disponibles.

Principe général :

```text
OBSERVE
   ↓
ANALYSE
   ↓
PRÉDIT
   ↓
RECOMMANDE
   ↓
HUMAIN VALIDE
   ↓
RÉSULTAT RÉEL
   ↓
ÉVALUATION
   ↓
APPRENTISSAGE
   ↓
CONFIANCE
   ↓
AUTOMATISATION PROGRESSIVE
```

---

# 3. IMPORTANT — Préserver l'existant

Avant toute modification :

1. analyser entièrement le projet existant ;
2. identifier l'architecture actuelle ;
3. identifier les services existants ;
4. identifier les modèles de données ;
5. identifier les jobs/crons ;
6. identifier les API RPOS ;
7. identifier le système actuel de propositions ;
8. identifier le fonctionnement actuel de `dailyHistory` ;
9. identifier le fonctionnement actuel de `forecastService.js` ;
10. identifier le fonctionnement actuel de `periodService.js` ;
11. identifier le fonctionnement actuel de `computeQuantityToOrder` ;
12. identifier le fonctionnement actuel de l'IA ;
13. identifier l'authentification existante.

**Ne pas réécrire inutilement les fonctionnalités existantes.**

L'objectif est de faire évoluer le système par couches.

---

# 4. Fonctionnement actuel à conserver

Le système possède actuellement les éléments suivants.

## 4.1 Déclenchement

Deux modes existent :

### Automatique

Le job :

```text
nightlyProposalJob
```

génère les propositions pour les magasins actifs.

Le traitement se fait actuellement avec une limite de concurrence de 3 magasins simultanément.

### Manuel

Un responsable magasin peut déclencher :

```text
Forcer une nouvelle génération
```

à partir de l'interface.

Cette fonctionnalité doit rester disponible.

---

# 5. Détermination de la période d'analyse

Le service :

```text
periodService.js
```

supporte actuellement :

```text
YESTERDAY
LAST_7_DAYS
LAST_30_DAYS
CUSTOM
```

La période est basée sur la **dernière vente réelle du magasin**, et non simplement sur la date système.

Ce comportement doit être conservé.

Exemple :

```text
Dernière vente : 07/09

LAST_7_DAYS

→ 31/08 → 07/09
```

---

# 6. Source des ventes

Le système utilise actuellement l'ordre de priorité :

```text
1. Fichier local exporté
2. SalesLine locale
3. RPOS
```

Le système doit conserver cette stratégie.

Le service :

```text
getSalesLinesForPeriod
```

reste la source principale des données historiques.

---

# 7. Pareto 30/80

Le calcul actuel :

```text
computeParetoFromLines
```

doit rester la base.

Le seuil :

```text
paretoThreshold
```

doit rester configurable.

Exemple :

```text
paretoThreshold = 0.80
```

Le système identifie les articles représentant les 80 % du CA.

Ces articles constituent les articles prioritaires du réassort.

---

# 8. Prévision actuelle

Pour chaque article retenu, le système dispose déjà d'une vente moyenne hebdomadaire.

Deux méthodes existent :

### Moyenne simple

```text
vente moyenne =
quantité totale / nombre de jours × 7
```

### Lissage exponentiel

Via :

```text
forecastService.js
```

si l'historique est suffisamment long.

Cette infrastructure doit être conservée.

Elle devra cependant être enrichie progressivement avec :

* tendance ;
* saisonnalité ;
* jour de la semaine ;
* volatilité ;
* événements ;
* promotions si la donnée est disponible ;
* précision historique du modèle.

---

# 9. Stock et commandes

Lors de la génération, le système interroge RPOS pour récupérer :

* stock actuel ;
* stock négatif ;
* commandes en cours ;
* commandes générées par la plateforme ;
* commandes déjà présentes dans RPOS ;
* statut commandable ;
* article générique ;
* article introuvable.

Les exclusions doivent continuer à être tracées dans :

```text
ExcludedArticle
```

---

# 10. Calcul actuel du réassort

La logique actuelle de :

```text
computeQuantityToOrder
```

doit être conservée comme moteur de base.

Formule actuelle :

```text
besoin =
    (vente_moyenne_hebdo / 7)
    × jours_de_couverture
    + stock_de_sécurité
    - stock_actuel
    - déjà_commandé
```

Puis :

```text
quantité finale
→ arrondi supérieur selon colisage
```

Ne pas supprimer ce calcul.

Il devient le **baseline déterministe** du futur moteur IA.

---

# 11. Nouveau concept : Weekly Replenishment Plan

Introduire une notion de :

```text
WeeklyReplenishmentPlan
```

ou équivalent selon l'architecture existante.

Une proposition doit être associée à une **semaine cible**.

Exemple :

```text
semaine analysée : Semaine 1
semaine cible : Semaine 2
```

La proposition créée lundi pour la semaine 2 doit rester liée à cette semaine.

Elle ne doit plus être simplement remplacée par une nouvelle proposition.

---

# 12. Révisions des propositions

Créer un système de versions/révisions.

Exemple :

```text
WeeklyPlan
    |
    ├── Revision 1
    │   lundi
    │
    ├── Revision 2
    │   mardi
    │
    ├── Revision 3
    │   mercredi
    │
    └── Revision 4
        jeudi
```

Chaque révision doit conserver :

* date ;
* heure ;
* source ;
* prévisions ;
* stock observé ;
* ventes observées ;
* commandes déjà passées ;
* quantités recommandées ;
* raison du changement ;
* modèle utilisé ;
* score de confiance.

---

# 13. Ne jamais perdre la proposition initiale

Exemple :

```text
LUNDI

IA prévoit :

Coca = 100
```

Mardi :

```text
ventes supérieures
```

Nouvelle proposition :

```text
Coca = 120
```

La version du lundi doit rester consultable.

L'utilisateur doit pouvoir voir :

```text
Lundi
100

Mardi
120

Évolution
+20
```

---

# 14. Différence entre recommandation et commande

Cette distinction est obligatoire.

Une recommandation IA :

```text
recommendedQuantity
```

n'est pas automatiquement une commande.

Une commande validée doit être stockée séparément :

```text
orderedQuantity
```

Exemple :

```text
IA recommande : 100
Magasin valide : 70
Commande RPOS : 70
```

Si mercredi l'IA recalcule :

```text
Besoin total estimé : 120
Déjà commandé : 70

Besoin supplémentaire : 50
```

L'IA doit proposer :

```text
+50
```

et non une nouvelle commande de 120.

---

# 15. Réassort continu

Créer un nouveau job quotidien :

```text
dailyReplenishmentReviewJob
```

Il doit :

1. récupérer les nouvelles ventes ;
2. récupérer le stock actuel ;
3. récupérer les commandes déjà passées ;
4. récupérer les nouvelles informations RPOS ;
5. comparer prévision et réalité ;
6. recalculer le besoin restant ;
7. détecter les anomalies ;
8. recalculer la confiance ;
9. générer une nouvelle révision si nécessaire.

---

# 16. Déclenchement intelligent

Ne pas nécessairement créer une nouvelle révision chaque jour si aucun changement significatif n'est détecté.

Introduire un paramètre :

```text
revisionChangeThreshold
```

Exemple :

```text
revisionChangeThreshold = 10%
```

Si la nouvelle recommandation change de moins de 10 % :

```text
pas nécessairement de nouvelle révision
```

Si elle change de plus de 10 % :

```text
nouvelle révision
```

Le seuil doit être configurable.

---

# 17. Trois horizons de prévision

Le moteur doit progressivement supporter :

## Court terme

```text
1 à 3 jours
```

Objectif :

* risque de rupture ;
* stock critique.

## Moyen terme

```text
7 jours
```

Objectif :

* réassort hebdomadaire.

## Long terme

```text
30 jours
```

Objectif :

* tendances ;
* saisonnalité ;
* planification.

---

# 18. Types de recommandations IA

L'IA ne doit pas uniquement retourner :

```text
COMMANDER
```

Elle doit pouvoir produire plusieurs types d'actions.

Enum recommandé :

```text
ORDER_NOW
ORDER_MORE
ORDER_LESS
WAIT
STOCK_RISK
OVERSTOCK
DEMAND_INCREASE
DEMAND_DECREASE
ANOMALY
VERIFY_STOCK
NO_ACTION
```

---

# 19. Exemple de recommandation

Structure conceptuelle :

```json
{
  "articleId": "...",
  "action": "ORDER_NOW",
  "recommendedQuantity": 80,
  "confidence": 0.91,
  "reason": [
    "Stock disponible inférieur à 2 jours",
    "Demande en hausse de 18%",
    "Article Pareto 30/80",
    "Délai fournisseur supérieur à la couverture actuelle"
  ]
}
```

---

# 20. Score de confiance

Chaque recommandation IA doit avoir :

```text
confidenceScore
```

entre :

```text
0 → 1
```

ou :

```text
0 → 100
```

Exemple :

```text
91 %
```

Le score doit prendre progressivement en compte :

* quantité d'historique ;
* stabilité des ventes ;
* volatilité ;
* précision historique ;
* qualité des données ;
* anomalies ;
* saisonnalité ;
* erreurs précédentes ;
* comportement du magasin ;
* comportement de l'article.

---

# 21. Historique des prédictions

Créer un historique de toutes les prédictions.

Concept :

```text
AIPrediction
```

Champs recommandés :

```text
id
storeId
articleId
predictionDate
targetDate
targetPeriod
predictedQuantity
predictedDailyDemand
predictedWeeklyDemand
stockAtPrediction
ordersAtPrediction
model
modelVersion
confidenceScore
reasoning
createdAt
```

---

# 22. Résultat réel

Après la période cible, enregistrer les résultats.

Concept :

```text
AIPredictionOutcome
```

Exemples :

```text
predictedQuantity
actualSales
actualStock
actualOrders
forecastError
absoluteError
percentageError
```

Calcul :

```text
forecastError =
actual - predicted
```

et :

```text
absolutePercentageError =
abs(actual - predicted) / actual
```

Gérer correctement les cas où `actual = 0`.

---

# 23. Mesure de performance de l'IA

Créer des KPI :

```text
forecastAccuracy
forecastBias
MAE
MAPE / WAPE selon pertinence
stockoutRate
overstockRate
recommendationAcceptanceRate
recommendationModificationRate
recommendationRejectionRate
```

Ces indicateurs doivent être disponibles :

* par magasin ;
* par article ;
* par rayon ;
* par période ;
* par modèle IA.

---

# 24. Apprentissage de l'IA

Le système doit conserver les différences entre :

```text
IA recommandait
```

et :

```text
Humain a validé
```

et :

```text
Résultat réel
```

Exemple :

```text
IA = 100
Humain = 70
Réel = 72
```

La recommandation humaine était plus proche.

Autre exemple :

```text
IA = 100
Humain = 50
Réel = 110
```

L'IA était meilleure.

Cette donnée doit alimenter le système de mesure de confiance.

---

# 25. Knowledge Base

Créer une couche de connaissance opérationnelle.

Elle ne doit pas être une simple mémoire conversationnelle.

Elle doit contenir :

```text
Store
 └── Article
      ├── historique
      ├── prévisions
      ├── résultats
      ├── erreurs
      ├── décisions humaines
      ├── saisonnalité
      ├── tendances
      └── confiance
```

Objectif :

déterminer si le système dispose d'une base historique suffisante pour automatiser.

---

# 26. Conditions minimales d'autonomie

Créer des paramètres configurables :

```text
autoReplenishmentEnabled
minimumPredictionHistory
minimumWeeksOfHistory
minimumPredictionCount
minimumConfidenceScore
maximumForecastError
maximumOrderAmount
maximumOrderQuantity
maximumQuantityVariation
```

Exemple initial :

```text
autoReplenishmentEnabled = false

minimumWeeksOfHistory = 12

minimumPredictionCount = 50

minimumConfidenceScore = 0.90

maximumForecastError = 0.10
```

Ces valeurs doivent être configurables et ne doivent pas être codées en dur.

---

# 27. Niveau d'autonomie

Créer :

```text
AUTONOMY_LEVEL
```

Valeurs :

```text
OBSERVE
PROPOSE
SUPERVISED
CONTROLLED_AUTO
AUTO
```

## OBSERVE

L'IA analyse mais ne propose pas.

## PROPOSE

L'IA propose.

Le magasin valide.

## SUPERVISED

L'IA propose.

Les cas normaux peuvent être rapidement validés.

## CONTROLLED_AUTO

Certaines commandes sont automatiquement validées si toutes les conditions sont satisfaites.

## AUTO

Réassort automatique complet pour les articles éligibles.

---

# 28. Éligibilité automatique

Un article ne doit pouvoir être commandé automatiquement que si :

```text
article commandable
AND
historique suffisant
AND
confiance suffisante
AND
erreur suffisamment faible
AND
aucune anomalie
AND
quantité raisonnable
AND
montant raisonnable
AND
aucune promotion exceptionnelle détectée
AND
stock fiable
```

Sinon :

```text
→ validation humaine obligatoire
```

---

# 29. Limites de sécurité

Créer des garde-fous.

Exemples :

```text
maxAutoOrderQuantity
maxAutoOrderAmount
maxDailyAutoOrderAmount
maxQuantityIncreasePercent
```

Si une recommandation dépasse une limite :

```text
BLOCKED_FOR_REVIEW
```

Le responsable doit valider.

---

# 30. Détection d'anomalies

Le système doit identifier :

### Explosion des ventes

```text
15
18
20
47
55
```

### Chute brutale

```text
40
42
39
12
9
```

### Stock incohérent

```text
stock RPOS = 100
ventes = 0
```

alors que l'article vend habituellement 30/jour.

### Rupture invisible

```text
stock théorique > 0
ventes = 0
```

L'IA doit pouvoir recommander :

```text
VERIFY_STOCK
```

au lieu de commander automatiquement.

---

# 31. Détection de tendance

Pour chaque article :

```text
trendScore
```

Exemples :

```text
+22%
-15%
stable
```

Catégories :

```text
GROWING
DECLINING
STABLE
VOLATILE
UNKNOWN
```

---

# 32. Analyse par jour de semaine

Le moteur doit pouvoir apprendre :

```text
Lundi
Mardi
Mercredi
Jeudi
Vendredi
Samedi
Dimanche
```

Exemple :

```text
Samedi = +35%
```

La prévision doit pouvoir intégrer cette saisonnalité hebdomadaire.

---

# 33. Personnalisation par magasin

Les magasins ne doivent pas partager aveuglément le même comportement.

Le système doit conserver des caractéristiques par magasin :

```text
storeId
averageDemand
demandVolatility
weeklyPattern
seasonality
forecastAccuracy
stockReliability
```

Une même référence peut donc avoir des prévisions différentes selon le magasin.

---

# 34. Chatbot IA

Ajouter un chatbot métier.

Nom conceptuel :

```text
AI Store Assistant
```

Le chatbot doit être connecté aux données du système.

Il doit répondre notamment à :

```text
Pourquoi dois-je commander cet article ?

Quels articles dois-je commander aujourd'hui ?

Quels articles risquent d'être en rupture ?

Pourquoi la quantité a augmenté ?

Pourquoi l'IA a changé sa proposition ?

Quels articles sont en surstock ?

Comment évoluent les ventes ?

Quelle est la précision de l'IA ?

Que s'est-il passé hier ?

Que prévoit l'IA pour cette semaine ?

Que se passe-t-il si les ventes augmentent de 20% ?
```

---

# 35. Chatbot — ne jamais inventer les données

Le chatbot doit utiliser les données réelles de l'application.

Il doit éviter de répondre avec une information qui n'existe pas dans les données.

Architecture recommandée :

```text
Utilisateur
   ↓
Chatbot
   ↓
Intent Detection
   ↓
Permission Check
   ↓
Data Retrieval / Tools
   ↓
Business Logic
   ↓
LLM
   ↓
Réponse
```

Le LLM ne doit pas être directement connecté à toute la base de données.

---

# 36. Tools du chatbot

Prévoir des outils internes tels que :

```text
getStoreStock()
getArticleStock()
getSales()
getSalesHistory()
getCurrentProposal()
getWeeklyPlan()
getPrediction()
getPredictionAccuracy()
getStockoutRisks()
getOverstockArticles()
getOrders()
simulateDemand()
explainRecommendation()
```

Le chatbot pourra appeler uniquement les outils autorisés.

---

# 37. Chatbot — exemples

Utilisateur :

> Pourquoi proposes-tu 80 Coca ?

Réponse attendue :

```text
Je recommande 80 unités parce que :

• les ventes augmentent de 18 % ;
• le stock actuel couvre environ 2 jours ;
• le délai de réception est de 3 jours ;
• l'article appartient au Pareto 30/80 ;
• une commande de 20 unités est déjà en cours.

Confiance : 91 %.
```

---

# 38. Chatbot — simulation

Exemple :

> Que se passe-t-il si les ventes augmentent de 20 % ?

Le chatbot doit pouvoir lancer une simulation sans modifier les données réelles.

Résultat :

```text
Scénario actuel :
120 unités

+20 % :
144 unités

Besoin supplémentaire :
24 unités
```

---

# 39. LDAP / Active Directory

Ajouter l'authentification LDAP.

Objectif :

```text
Utilisateur
 ↓
LDAP / Active Directory
 ↓
Authentification
 ↓
Application
 ↓
Rôles
 ↓
Permissions
```

Ne pas stocker les mots de passe LDAP dans la base applicative.

Utiliser une configuration sécurisée.

---

# 40. Configuration LDAP

Tous les paramètres doivent être configurables via variables d'environnement.

Exemple :

```env
LDAP_ENABLED=true

LDAP_URL=ldap://ldap.example.local
LDAP_BASE_DN=dc=example,dc=local

LDAP_BIND_DN=...
LDAP_BIND_PASSWORD=...

LDAP_USER_BASE_DN=ou=users,dc=example,dc=local

LDAP_USER_FILTER=(sAMAccountName={username})

LDAP_GROUP_BASE_DN=ou=groups,dc=example,dc=local

LDAP_USE_TLS=true
LDAP_VERIFY_CERT=true
```

Ne jamais mettre les secrets dans Git.

---

# 41. RBAC

LDAP authentifie l'utilisateur.

L'application gère les autorisations.

Créer au minimum :

```text
STORE_MANAGER
SECTOR_MANAGER
SUPPLY_MANAGER
ADMIN
```

---

# 42. Permissions

Exemple :

```text
STORE_MANAGER

→ voir son magasin
→ voir les stocks
→ voir les propositions
→ modifier les quantités
→ valider
→ consulter le chatbot
```

```text
SECTOR_MANAGER

→ plusieurs magasins
→ comparaison
→ suivi des recommandations
```

```text
SUPPLY_MANAGER

→ tous les magasins
→ commandes
→ performance IA
→ paramètres réassort
```

```text
ADMIN

→ configuration
→ utilisateurs
→ LDAP
→ IA
→ paramètres
→ logs
```

---

# 43. Sécurité du chatbot

Le chatbot doit respecter les permissions.

Exemple :

Un utilisateur du magasin A demande :

```text
Donne-moi le stock du magasin B.
```

Si son rôle ne l'autorise pas :

```text
Accès refusé.
```

Le LLM ne doit jamais contourner les permissions.

---

# 44. Dashboard AI Center

Créer une section :

```text
AI CENTER
```

Elle doit afficher :

```text
Prévisions
Recommandations
Précision IA
Erreurs
Ruptures
Surstocks
Confiance
Autonomie
```

KPI :

```text
Nombre de prédictions
Précision globale
MAE
WAPE
Recommandations acceptées
Recommandations modifiées
Recommandations refusées
Commandes automatiques
Interventions humaines
Ruptures évitées
Surstocks évités
```

---

# 45. AI Performance par magasin

Exemple :

```text
MAGASIN X

Prévisions :
2 450

Précision :
92 %

Erreur moyenne :
8 %

Confiance :
91 %

Niveau autonomie :
SUPERVISED
```

---

# 46. AI Performance par article

Exemple :

```text
COCA 1.5L

Prévisions :
147

Précision :
94 %

Erreur :
6 %

Historique :
32 semaines

Confiance :
95 %

Autonomie :
AUTO
```

---

# 47. Journal des décisions IA

Créer un audit log.

Concept :

```text
AIDecisionLog
```

Enregistrer :

```text
user / system
store
article
decision
quantity
confidence
reason
model
modelVersion
timestamp
result
```

Objectif :

pouvoir répondre à :

> Pourquoi cette commande a-t-elle été créée ?

---

# 48. Traçabilité complète

Pour chaque commande automatique future :

```text
Commande RPOS
   ↓
Recommendation
   ↓
Prediction
   ↓
Model version
   ↓
Input data
   ↓
Confidence
   ↓
Rules passed
   ↓
Decision
```

Il doit être possible de reconstruire la décision.

---

# 49. Mode simulation

Avant d'autoriser l'automatisation réelle, prévoir :

```text
AUTO_SIMULATION_MODE=true
```

Dans ce mode :

```text
IA décide
↓
système simule la commande
↓
aucune commande RPOS réelle
↓
résultat enregistré
```

Cela permettra de tester l'autonomie sans risque.

---

# 50. Mode Shadow AI

Prévoir également un mode :

```text
SHADOW_MODE
```

L'IA prend des décisions comme si elle était autonome mais :

```text
aucune commande réelle
```

On compare :

```text
Décision IA
VS
Décision humaine
VS
Résultat réel
```

C'est fortement recommandé avant le passage en production automatique.

---

# 51. Pipeline cible

Architecture logique :

```text
                    RPOS
                     ↓
              Data Collection
                     ↓
              SalesLine / Stock
                     ↓
              Analytics Engine
                     ↓
        ┌────────────┼─────────────┐
        ↓            ↓             ↓
     Pareto       Forecast      Anomaly
        │            │             │
        └────────────┼─────────────┘
                     ↓
               AI Decision Engine
                     ↓
             Recommendation
                     ↓
              Confidence Engine
                     ↓
             Safety Rules Engine
                     ↓
        ┌────────────┴─────────────┐
        ↓                          ↓
   Human Validation           Auto Decision
        ↓                          ↓
        └────────────┬─────────────┘
                     ↓
                    RPOS
                     ↓
              Real Outcome
                     ↓
             AI Evaluation
                     ↓
              Knowledge Base
                     ↓
              Model Improvement
```

---

# 52. Architecture technique recommandée

Ne pas mettre toute l'intelligence dans le LLM.

Séparer :

```text
Deterministic Engine
+
Forecast Engine
+
Anomaly Engine
+
AI Reasoning Layer
+
Recommendation Engine
+
Safety Engine
+
Chatbot
```

Le LLM doit principalement :

* expliquer ;
* raisonner sur les résultats ;
* synthétiser ;
* répondre aux questions ;
* proposer des décisions complémentaires.

Les calculs critiques doivent rester déterministes lorsque possible.

---

# 53. Règle importante sur l'IA

Ne jamais demander au LLM de calculer seul :

```text
stock
quantité
CA
ventes
besoin
commande
```

Le backend calcule.

L'IA interprète et recommande.

Exemple :

```text
Backend :
besoin = 83

LLM :
explique pourquoi 83 est recommandé.
```

---

# 54. Configuration centralisée

Prévoir une configuration de ce type :

```env
# PARETO

PARETO_THRESHOLD=0.80


# FORECAST

FORECAST_METHOD=EXPONENTIAL
FORECAST_MIN_HISTORY_DAYS=14


# REPLENISHMENT

DEFAULT_COVERAGE_DAYS=7
USE_LEAD_TIME_AS_COVERAGE=true
SAFETY_STOCK_ENABLED=true


# CONTINUOUS REPLENISHMENT

CONTINUOUS_REPLENISHMENT_ENABLED=true
DAILY_REVIEW_CRON=...
REVISION_CHANGE_THRESHOLD=0.10


# AI

AI_ENABLED=true
AI_PROVIDER=gemini
AI_MODEL=...
AI_MIN_CONFIDENCE=0.90


# AUTONOMY

AUTO_REPLENISHMENT_ENABLED=false
AUTONOMY_LEVEL=PROPOSE

MINIMUM_WEEKS_OF_HISTORY=12
MINIMUM_PREDICTION_COUNT=50

MAX_FORECAST_ERROR=0.10
MAX_AUTO_ORDER_AMOUNT=...
MAX_AUTO_ORDER_QUANTITY=...
MAX_DAILY_AUTO_ORDER_AMOUNT=...


# CHATBOT

CHATBOT_ENABLED=true


# LDAP

LDAP_ENABLED=true
LDAP_URL=...
LDAP_BASE_DN=...
LDAP_USER_BASE_DN=...
LDAP_GROUP_BASE_DN=...
LDAP_USE_TLS=true
LDAP_VERIFY_CERT=true
```

Les noms exacts doivent être adaptés aux conventions déjà utilisées dans le projet.

---

# 55. Workflow hebdomadaire

Chaque lundi :

```text
Semaine précédente
       ↓
Analyse ventes
       ↓
Pareto
       ↓
Prévision
       ↓
Stock
       ↓
Commandes
       ↓
Proposition semaine cible
```

Exemple :

```text
Lundi 8 septembre

Analyse :
1 → 7 septembre

Cible :
8 → 14 septembre
```

---

# 56. Workflow quotidien

Chaque jour :

```text
Nouvelles ventes
      ↓
Stock actuel
      ↓
Commandes existantes
      ↓
Comparaison avec prévision
      ↓
Nouvelle prévision
      ↓
Besoin restant
      ↓
Anomalies
      ↓
Confiance
      ↓
Nouvelle recommandation si nécessaire
```

---

# 57. Workflow de validation

```text
AI Recommendation
       ↓
Responsable
       ↓
┌──────┼────────┐
↓      ↓        ↓
VALID  MODIFY   REJECT
↓      ↓        ↓
RPOS   RPOS     Aucun
```

Toutes les décisions doivent être enregistrées.

---

# 58. Transition vers l'automatisation

Le passage en automatique doit être progressif.

### Étape 1

```text
100 % humain
```

### Étape 2

```text
IA propose
```

### Étape 3

```text
IA propose + mesure performance
```

### Étape 4

```text
Shadow Mode
```

### Étape 5

```text
Auto sur quelques articles fiables
```

### Étape 6

```text
Auto sur certains magasins
```

### Étape 7

```text
Auto global contrôlé
```

---

# 59. Auto-replenishment par article

L'autonomie ne doit pas forcément être définie uniquement au niveau magasin.

Elle peut être :

```text
store + article
```

Exemple :

```text
Magasin A
Coca → AUTO
Eau → AUTO
Jus → SUPERVISED
Produit X → HUMAN
```

Cela permet une transition beaucoup plus sûre.

---

# 60. Auto-replenishment par magasin

Un magasin peut également avoir :

```text
autonomyLevel
```

Exemple :

```text
Magasin A → AUTO
Magasin B → SUPERVISED
Magasin C → PROPOSE
```

---

# 61. Chatbot — contexte utilisateur

Le chatbot doit connaître le contexte autorisé :

```text
user
role
store
sector
permissions
```

Exemple :

```text
Bonjour,

Voici la situation de votre magasin aujourd'hui :
...
```

Mais uniquement avec les données accessibles à l'utilisateur.

---

# 62. Notifications IA

Prévoir des notifications :

```text
🚨 Risque de rupture

📦 Réassort recommandé

📈 Demande en hausse

📉 Demande en baisse

⚠️ Anomalie de stock

📦 Surstock

🤖 Proposition révisée

🧠 Confiance IA insuffisante
```

---

# 63. Explication des changements

Chaque modification de recommandation doit pouvoir afficher :

```text
Ancienne recommandation :
80

Nouvelle recommandation :
110

Variation :
+30

Raisons :

• ventes supérieures de 21 %
• stock inférieur à la prévision
• demande en croissance
• risque de rupture sous 48 h
```

---

# 64. Historique utilisateur

Le responsable doit pouvoir consulter :

```text
Aujourd'hui
Hier
Cette semaine
Semaine précédente
```

avec :

* recommandations ;
* validations ;
* modifications ;
* refus ;
* résultats.

---

# 65. Tests obligatoires

Avant toute mise en production :

### Tests unitaires

Tester :

```text
Pareto
Forecast
Stock
Safety stock
Quantity
Revision
Confidence
Autonomy
```

### Tests d'intégration

Tester :

```text
RPOS
Database
Jobs
AI
LDAP
Chatbot
```

### Tests sécurité

Tester :

```text
LDAP
RBAC
accès inter-magasins
chatbot permissions
API
secrets
```

### Tests IA

Tester :

```text
historique insuffisant
données manquantes
anomalies
stock négatif
ventes = 0
forte croissance
forte baisse
promotion
commande déjà existante
```

---

# 66. Critères de réussite Phase 1

La première version doit permettre :

```text
✓ Analyse hebdomadaire
✓ Proposition semaine cible
✓ Révisions
✓ Historique des versions
✓ Réajustement quotidien
✓ Validation humaine
✓ Mesure prévision/réalité
✓ Score de confiance
✓ Explication IA
✓ LDAP
✓ RBAC
✓ Chatbot de base
```

Mais :

```text
AUTO_REPLENISHMENT_ENABLED=false
```

par défaut.

---

# 67. Critères de réussite Phase 2

Le système doit pouvoir mesurer :

```text
✓ précision par article
✓ précision par magasin
✓ précision par période
✓ erreurs IA
✓ décisions humaines
✓ résultats réels
✓ niveau de confiance
✓ éligibilité à l'autonomie
```

---

# 68. Critères de réussite Phase 3

Le système doit permettre :

```text
✓ Shadow Mode
✓ Auto sur articles fiables
✓ Limites de sécurité
✓ Auto par magasin
✓ Auto par article
✓ Audit complet
✓ Rollback / arrêt automatique
```

---

# 69. Règle de sécurité absolue

En cas de doute :

```text
NE PAS COMMANDER AUTOMATIQUEMENT.
```

L'IA doit préférer :

```text
HUMAN_REVIEW
```

si :

* confiance faible ;
* données insuffisantes ;
* anomalie ;
* quantité inhabituelle ;
* montant inhabituel ;
* historique insuffisant ;
* problème RPOS ;
* problème de synchronisation.

---

# 70. Objectif final

Le système final doit fonctionner ainsi :

```text
                 CONTINUOUS AI REPLENISHMENT

                         RPOS
                          ↓
                       DATA
                          ↓
                    OBSERVATION
                          ↓
                       FORECAST
                          ↓
                      ANALYSIS
                          ↓
                    AI DECISION
                          ↓
                 CONFIDENCE ENGINE
                          ↓
                  SAFETY ENGINE
                          ↓
             ┌────────────┴────────────┐
             ↓                         ↓
       HUMAN REQUIRED              AUTO
             ↓                         ↓
          VALIDATE                 RPOS ORDER
             └────────────┬────────────┘
                          ↓
                     REAL RESULT
                          ↓
                   AI EVALUATION
                          ↓
                    KNOWLEDGE
                          ↓
                 BETTER PREDICTION
                          ↓
                  MORE CONFIDENCE
                          ↓
                  MORE AUTONOMY
```

Le système doit donc progressivement passer de :

```text
"Je propose."
```

à :

```text
"Je propose parce que..."
```

puis :

```text
"Je sais que mes prédictions sont fiables dans ce contexte."
```

et finalement :

```text
"Je peux commander automatiquement dans ce contexte,
car mon niveau de confiance et mes règles de sécurité
sont satisfaits."
```

---

# 71. Instruction finale pour l'agent Claude

Avant de coder :

1. analyser le projet existant ;
2. produire un état des lieux de l'architecture ;
3. identifier les fichiers concernés ;
4. identifier les modèles concernés ;
5. identifier les risques de régression ;
6. proposer un plan de migration ;
7. ne pas supprimer les fonctionnalités existantes ;
8. conserver la compatibilité avec RPOS ;
9. conserver la validation humaine ;
10. implémenter progressivement par petites étapes ;
11. tester chaque étape ;
12. ne jamais activer automatiquement les commandes réelles sans configuration explicite.

Ordre recommandé :

```text
STEP 1
WeeklyReplenishmentPlan

STEP 2
Proposal Revision History

STEP 3
Daily Continuous Review

STEP 4
Prediction History

STEP 5
Prediction Outcome / AI Evaluation

STEP 6
Confidence Engine

STEP 7
Anomaly Detection

STEP 8
AI Recommendation Engine

STEP 9
AI Center

STEP 10
LDAP + RBAC

STEP 11
AI Chatbot

STEP 12
Shadow Mode

STEP 13
Controlled Auto Replenishment

STEP 14
Full Auto Replenishment
```

**Ne pas implémenter les étapes futures prématurément si elles risquent de complexifier ou casser l'existant.**

Le système doit être conçu pour évoluer progressivement vers l'autonomie.

---

# 72. État d'avancement (vérifié le 11/09/2026)

Point de suivi par rapport à l'ordre recommandé §71 — à mettre à jour au fil de l'avancement, pas figé.

## Fait / en place

* STEP 1 — `WeeklyReplenishmentPlan` (modèle présent) ;
* STEP 3 — Daily Continuous Review (`dailyReplenishmentReviewJob.js`) ;
* STEP 4 — Prediction History (`AIPrediction`) ;
* STEP 5 — Prediction Outcome (`AIPredictionOutcome`) ;
* Périodes d'analyse, Pareto, calcul déterministe, exclusions (`ExcludedArticle`), synchro des ventes locale (§4-10) ;
* Séparation calcul backend / interprétation IA respectée (§53) ;
* STEP 6 — Confidence Engine (`confidenceService.js`) : score 0-100 pondéré sur 4 signaux réels (longueur d'historique, volatilité/coefficient de variation, précision historique passée via `AIPredictionOutcome`, qualité des données/rupture de stock), avec repli neutre (jamais optimiste) quand un signal manque. Il ne reste à y intégrer que les signaux anomalie et saisonnalité (dépendent de STEP 7, non fait) et le "comportement magasin/article" distinct (pas encore modélisé séparément).

## Partiel / à vérifier

* §16 — `REVISION_CHANGE_THRESHOLD` existe en configuration, mais son application réelle dans le job de révision quotidienne n'a pas été revérifiée récemment ;
* §18 — l'IA ne produit aujourd'hui qu'une quantité + un texte de raisonnement libre, pas un type d'action structuré (`ORDER_NOW`, `WAIT`, `ANOMALY`, etc.).

## Fait / en place (suite)

* STEP 7 — Anomaly Detection (`anomalyService.js`) : détecte explosion/chute de ventes (comparaison 3 derniers jours vs reste de la période), stock incohérent/rupture invisible (stock disponible mais 0 vente récente sur un article qui vend habituellement), et catégorise la tendance générale (`trendCategory` : GROWING/DECLINING/STABLE/VOLATILE/UNKNOWN, §31). Intégré au Confidence Engine (pénalise `dataQuality`) et transmis à l'IA (prompt étape 0bis) pour privilégier la prudence plutôt qu'une extrapolation aveugle (§69). Nécessite au moins 7 jours d'historique local pour se déclencher — sans effet tant que la couverture de données réelle est plus courte (ex: après une purge récente).

## Fait / en place (suite 2)

* STEP 11 — AI Chatbot (`chatbotService.js`, `chatbotToolsService.js`, page `ai-assistant.html`) : architecture Intent Detection -> Tools -> LLM (§35) respectée — détection d'intention par mots-clés (déterministe, pas d'appel LLM pour router), 8 outils dédiés lisant uniquement les vraies données en base (stock, ventes, ruptures, surstock, précision IA, commandes), jamais d'accès direct base pour le LLM. Sécurisé par `resolveShopId` (§43, un utilisateur ne peut interroger que son propre magasin). Mémoire de conversation, questions suggérées, sélection magasin/rayon/sous-rayon.

## Pas commencé

* STEP 9 — AI Center (dashboard dédié précision/KPI) ;
* STEP 10 — LDAP + RBAC (rôles fins) ;
* §32 — saisonnalité par jour de semaine ;
* §47-48 — `AIDecisionLog` / traçabilité complète ;
* STEP 12 — Shadow Mode ;
* STEP 13-14 — Auto Replenishment contrôlé/complet (prématuré à ce stade, cohérent avec l'ordre recommandé).

Rien de ce qui précède n'est bloquant pour l'usage courant (génération, validation, ajustement IA à la demande, synchro des ventes) : ce sont des couches d'amélioration à ajouter progressivement, dans l'ordre du §71.

# FIN DU README
