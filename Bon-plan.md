# PLAN D’ÉVOLUTION DU PROJET — RÉASSORT IA

## 1. Objectif général

Faire évoluer l'application de réassort automatique vers un système intelligent capable de :

1. sélectionner les articles 20/80 d'un magasin ;
2. effectuer les calculs métier classiques ;
3. analyser l'historique détaillé des ventes ;
4. détecter les anomalies et situations particulières ;
5. utiliser une IA pour interpréter les données ;
6. produire une quantité proposée finale ;
7. expliquer clairement pourquoi cette quantité est proposée ;
8. vérifier la proposition avec un moteur de règles ;
9. enregistrer la décision de l'utilisateur ;
10. mesurer ensuite l'écart entre la proposition et les ventes réelles ;
11. utiliser cet historique pour améliorer progressivement les futures propositions.

IMPORTANT :
Ne pas remplacer brutalement la logique actuelle.
Commencer par analyser le code existant, les modèles de données, les services et les calculs actuels.

---

# 2. Architecture cible

Mettre en place cette chaîne :

DONNÉES
↓
SÉLECTION 20/80
↓
CALCULS MÉTIER
↓
HISTORIQUE JOUR PAR JOUR
↓
ANALYSE IA
↓
MOTEUR DE VALIDATION
↓
QUANTITÉ PROPOSÉE FINALE
↓
EXPLICATION
↓
VALIDATION UTILISATEUR
↓
SUIVI DU RÉSULTAT RÉEL
↓
MESURE DE L'ERREUR
↓
AMÉLIORATION FUTURE

---

# 3. Étape 1 — Audit du projet existant

Avant toute modification :

* analyser l'architecture ;
* identifier le frontend ;
* identifier le backend ;
* identifier la base de données ;
* identifier les modèles concernés ;
* identifier les services de calcul ;
* identifier `nightlyProposalJob` ;
* identifier `periodService.js` ;
* identifier `computeQuantityToOrder` ;
* identifier `dailyHistory` ;
* identifier `SalesLine` ;
* identifier `ProductCache` ;
* identifier `RecentOrderCache` ;
* identifier `ProposalLine` ;
* identifier la logique Pareto 20/80 ;
* identifier la logique des commandes récentes ;
* identifier le système actuel de génération des propositions.

NE PAS coder immédiatement.

Produire d'abord un rapport d'audit indiquant :

* fichiers concernés ;
* fonctions concernées ;
* flux actuel ;
* données disponibles ;
* données manquantes ;
* risques de régression ;
* modifications nécessaires.

---

# 4. Étape 2 — Sélection des articles 20/80

Pour chaque magasin actif :

1. récupérer les ventes ;
2. calculer le Pareto ;
3. identifier les articles 20/80 ;
4. ne lancer l'analyse IA détaillée que sur les articles concernés.

Conserver la possibilité de modifier le seuil depuis la configuration.

Exemple :

paretoThreshold = 80

L'IA ne doit pas analyser aveuglément tous les articles si la logique métier demande uniquement les articles prioritaires.

---

# 5. Étape 3 — Calcul métier classique

Pour chaque article sélectionné, calculer les informations nécessaires :

* ventes journalières ;
* moyenne journalière ;
* moyenne récente ;
* moyenne historique ;
* tendance ;
* stock actuel ;
* quantité déjà commandée ;
* délai de réception ;
* stock de sécurité ;
* dernières commandes ;
* date de dernière vente ;
* date de dernière commande ;
* quantité vendue sur différentes périodes.

Ces données doivent servir de BASE à l'IA.

IMPORTANT :

L'interface utilisateur ne doit pas simplement afficher tous les champs techniques bruts.

Les calculs internes peuvent rester riches, mais l'IA doit transformer ces données en une recommandation compréhensible.

---

# 6. Étape 4 — Historique journalier

Créer une représentation structurée de l'historique.

Exemple :

Article A001 :

Date       Vente
01/09      40
02/09      130
03/09      340
04/09      132
05/09      90
06/09      75
07/09      68
08/09      60
09/09      50
10/09      35

L'IA doit pouvoir analyser :

* évolution ;
* tendance ;
* pics ;
* chutes ;
* jours sans vente ;
* stabilité ;
* accélération ;
* ralentissement ;
* saisonnalité éventuelle.

Ne pas uniquement envoyer une moyenne à l'IA.

L'historique jour par jour doit être disponible.

---

# 7. Étape 5 — Gestion intelligente des données

L'IA doit savoir distinguer plusieurs situations.

CAS A — Données récentes normales

→ analyse normale.

CAS B — Activité faible

→ avertir que l'historique est limité.

CAS C — Données arrêtées depuis longtemps

Exemple :

Dernière activité en 2025 alors que nous sommes en 2026.

→ ne pas considérer automatiquement ces données comme représentatives.

CAS D — Magasin actif

→ analyser son activité réelle.

CAS E — Magasin sans activité récente

→ identifier l'anomalie et expliquer la situation.

CAS F — Article déjà commandé

→ ne pas générer inutilement une nouvelle commande.

Afficher par exemple :

"Une commande de 50 unités a déjà été enregistrée le 08/09. Aucune nouvelle quantité n'est nécessaire pour le moment."

---

# 8. Étape 6 — Analyse IA

Créer un service dédié à l'analyse IA.

Exemple conceptuel :

AIReplenishmentAnalyzer

Entrées :

* magasin ;
* article ;
* historique journalier ;
* résultats des calculs classiques ;
* stock ;
* commandes ;
* délai fournisseur ;
* contexte magasin ;
* informations de qualité des données.

Sorties structurées :

{
"quantityProposed": 45,
"confidence": 0.82,
"reason": "...",
"trend": "decreasing",
"anomalies": [],
"warnings": [],
"factors": [],
"recommendation": "..."
}

IMPORTANT :

La quantité proposée finale doit être clairement identifiable.

---

# 9. Étape 7 — Explication humaine

Créer une explication compréhensible.

Exemple :

"Les ventes moyennes sur les 10 derniers jours sont de 50 unités/jour, mais les ventes récentes sont descendues autour de 35 unités/jour. La tendance est donc à la baisse. Compte tenu du stock actuel et du délai de réception de 3 jours, une proposition de 45 unités est retenue."

Ne pas afficher inutilement des informations techniques comme :

"confidence history = 0"
"data quality = 100%"
"stock calculation = X"

sauf dans une section technique/audit.

---

# 10. Étape 8 — Moteur de validation

L'IA ne doit jamais être la seule autorité.

Après la réponse IA, exécuter un moteur de règles.

Vérifier :

* article actif ;
* magasin actif ;
* historique suffisant ;
* dernière vente ;
* commande récente ;
* commande fournisseur en cours ;
* quantité négative ;
* quantité anormalement élevée ;
* quantité anormalement faible ;
* rupture potentielle ;
* données incohérentes ;
* stock incohérent ;
* date incohérente.

Si une règle bloque la proposition :

→ signaler le problème.

Si une règle détecte une anomalie :

→ conserver la proposition mais ajouter un avertissement.

---

# 11. Étape 9 — Décision utilisateur

Pour chaque proposition :

[ Marquer appliqué ]

[ Ignorer ]

L'utilisateur doit pouvoir voir :

* proposition ;
* justification ;
* données principales ;
* anomalie éventuelle ;
* historique ;
* date de génération ;
* utilisateur ;
* magasin ;
* article.

---

# 12. Étape 10 — Feedback

Créer un système de feedback.

Enregistrer :

* quantité proposée ;
* quantité appliquée ;
* quantité ignorée ;
* date ;
* utilisateur ;
* magasin ;
* article ;
* raison éventuelle du rejet ;
* résultat réel après plusieurs jours.

Exemple :

Proposition : 45
Appliquée : oui
Vente réelle : 42
Erreur : 3

---

# 13. Étape 11 — Mesure de performance

Calculer automatiquement :

MAE
MAPE lorsque pertinent
erreur moyenne
erreur absolue
biais de sur-prévision
biais de sous-prévision

Suivre les performances :

* par article ;
* par magasin ;
* par rayon ;
* par période ;
* par fournisseur si disponible.

L'objectif est de savoir si les propositions deviennent plus pertinentes avec le temps.

---

# 14. Étape 12 — Mémoire du système

Créer une mémoire historique des performances.

Exemple :

Article A001 / Magasin 050

Historique :

Prévision 50 → vente réelle 48
Prévision 55 → vente réelle 51
Prévision 60 → vente réelle 57

Erreur moyenne ≈ 6 %

Cette information pourra être utilisée dans les futures analyses.

IMPORTANT :

Il ne s'agit pas forcément d'entraîner le LLM lui-même.

La première version doit utiliser les données historiques comme contexte.

---

# 15. Étape 13 — Préparer un futur modèle ML

Ne pas commencer immédiatement par du machine learning complexe.

Préparer cependant les données pour permettre plus tard un modèle prédictif.

Variables potentielles :

* ventes J-1 ;
* J-2 ;
* J-3 ;
* moyenne 7 jours ;
* moyenne 14 jours ;
* moyenne 30 jours ;
* tendance ;
* jour de semaine ;
* saison ;
* stock ;
* commandes ;
* délai fournisseur ;
* historique article ;
* historique magasin.

Le futur modèle pourra produire :

DEMANDE PRÉVUE

Puis le LLM pourra expliquer cette prévision.

---

# 16. Étape 14 — Audit complet

Chaque génération doit être traçable.

Enregistrer :

* date ;
* heure ;
* magasin ;
* article ;
* utilisateur ;
* quantité calculée ;
* quantité IA ;
* quantité finale ;
* version du moteur ;
* version du prompt ;
* modèle IA utilisé ;
* données utilisées ;
* règles déclenchées ;
* anomalies ;
* décision utilisateur.

Le système doit permettre de répondre à :

"Pourquoi l'IA a proposé cette quantité ?"

---

# 17. Étape 15 — Historique des améliorations

Créer un historique des changements du système.

Exemple :

Version 1.2.0
Date : 10/09/2026

Modification :
Amélioration de la détection des baisses de ventes.

Impact :
Les ventes des 7 derniers jours ont maintenant plus de poids dans l'analyse.

Version 1.3.0
Date : ...

Modification :
Ajout de la détection des commandes récentes.

---

# 18. Règle importante pour le développement

NE PAS modifier plusieurs parties simultanément sans validation.

Procéder ainsi :

PHASE 1
Audit

↓

PHASE 2
Modèle de données

↓

PHASE 3
Historique journalier

↓

PHASE 4
Service d'analyse IA

↓

PHASE 5
Moteur de validation

↓

PHASE 6
Interface

↓

PHASE 7
Feedback

↓

PHASE 8
Mesure des performances

↓

PHASE 9
Tests

↓

PHASE 10
Optimisation

Après chaque phase :

* lancer les tests ;
* vérifier les données ;
* vérifier les régressions ;
* documenter les changements.

---

# 19. Contraintes importantes

1. Ne pas casser la logique actuelle de réassort.
2. Ne pas supprimer les calculs existants sans justification.
3. Ne pas faire confiance aveuglément à l'IA.
4. Toujours conserver les données sources.
5. Toutes les décisions IA doivent être traçables.
6. Toutes les propositions doivent pouvoir être expliquées.
7. Les données anciennes doivent être distinguées des données récentes.
8. Les magasins doivent être analysés individuellement.
9. Les commandes déjà existantes doivent être prises en compte.
10. L'utilisateur doit pouvoir accepter ou ignorer une proposition.
11. Le système doit apprendre de ses résultats via les données de feedback.
12. Préparer l'architecture pour intégrer ultérieurement un modèle ML.

---

# 20. Première tâche à exécuter

NE MODIFIE PAS LE CODE POUR LE MOMENT.

Commence uniquement par :

1. analyser complètement le projet ;
2. identifier le flux actuel ;
3. identifier les fichiers concernés ;
4. identifier les modèles et tables ;
5. identifier les calculs actuels ;
6. identifier comment les propositions sont générées ;
7. identifier comment l'IA est actuellement intégrée ;
8. identifier les points à modifier ;
9. proposer l'architecture technique ;
10. produire un plan de migration étape par étape.

Ensuite seulement, commencer l'implémentation.

Pour chaque modification, indiquer :

* fichier ;
* fonction ;
* modification ;
* raison ;
* impact ;
* test à effectuer.

Ne jamais inventer une fonction ou un modèle qui n'existe pas : vérifier d'abord le code réel du projet.



# MISSION — CONSTRUIRE L’ASSISTANT IA DU SYSTÈME DE RÉASSORT AUTOMATIQUE

Tu travailles sur mon projet existant de **réassort automatique assisté par IA**.

Avant toute modification, tu dois comprendre précisément l’architecture actuelle du projet et réutiliser au maximum l’existant.

## 1. RÈGLE ABSOLUE : AUDITER AVANT DE MODIFIER

Ne commence pas directement à coder.

Commence par analyser le dépôt complet afin d'identifier :

* frontend
* backend
* API
* authentification
* gestion des rôles et permissions
* modèles / ORM
* tables de base de données
* relations entre les tables
* services métier
* fonctions existantes
* calcul du réassort
* génération des propositions
* historique des ventes
* gestion du stock
* commandes fournisseurs
* commandes RPOS
* magasins
* produits/articles
* système d’IA actuel
* jobs/cron
* génération nocturne
* logs
* système d’audit
* système de notifications
* graphiques existants
* composants UI existants.

Tu dois notamment rechercher et comprendre les éléments déjà présents comme :

* `nightlyProposalJob`
* `periodService.js`
* `computeQuantityToOrder`
* `dailyHistory`
* `SalesLine`
* `ProductCache`
* `RecentOrderCache`
* `ProposalLine`
* `quantitySuggested`
* `paretoThreshold`
* les calculs de moyenne de vente
* stock de sécurité
* délai de réception
* historique RPOS
* commandes récentes
* logique 20/80
* logique de génération des propositions.

**Ne recrée pas une fonction qui existe déjà.**

Si une fonction existante peut être réutilisée, utilise-la.

Si une fonction est insuffisante, explique pourquoi et propose une amélioration ou un wrapper/adaptateur.

---

# 2. OBJECTIF DE L’ASSISTANT IA

Je veux intégrer dans mon application un véritable **assistant IA métier spécialisé dans le réassort**.

Ce n'est pas simplement un chatbot qui répond à des questions générales.

L’assistant doit être capable de comprendre les données et la logique métier de mon application et d’utiliser les fonctions backend existantes pour répondre aux utilisateurs.

Exemples de questions :

> Pourquoi l'article 123456 a une quantité proposée de 50 ?

> Montre-moi l'historique des ventes de cet article.

> Pourquoi la quantité proposée a augmenté aujourd'hui ?

> Quel est le comportement des ventes de cet article sur les 10 derniers jours ?

> Est-ce que cet article a déjà été commandé ?

> Pourquoi aucun réassort n'est proposé ?

> Analyse le magasin 050.

> Est-ce qu'il y a une anomalie dans ce magasin ?

> Compare les ventes de cette semaine avec la semaine précédente.

> Quels articles ont besoin d'une vérification ?

> Pourquoi cette proposition est différente du calcul habituel ?

> Est-ce que l'article est déjà en commande fournisseur ?

> Quelles recommandations dois-je traiter en priorité ?

L'assistant doit répondre à partir des **données réelles de l'application**, pas inventer les réponses.

---

# 3. L'IA NE DOIT PAS ACCÉDER DIRECTEMENT À LA BASE DE DONNÉES

C'est une règle d'architecture importante.

L'IA ne doit jamais recevoir un accès SQL libre à la base de données.

Architecture souhaitée :

```text
Utilisateur
    ↓
Assistant IA
    ↓
Tool / Function Calling
    ↓
Services métier existants
    ↓
ORM / Repositories
    ↓
Base de données
```

L'IA doit utiliser des **tools contrôlés**.

Par exemple :

```text
getSalesHistory()
getCurrentProposal()
getCurrentStock()
getPendingOrders()
getProduct()
getStore()
getDailyHistory()
analyzeProposal()
analyzeStore()
detectAnomalies()
getRecommendationHistory()
```

Chaque tool doit appeler les services backend appropriés.

---

# 4. CLAUDE DOIT CONNAÎTRE LES TABLES ET FONCTIONS EXISTANTES

Pendant l'audit, identifie précisément :

### Tables / modèles

Par exemple, selon ce qui existe réellement dans le projet :

```text
SalesLine
ProductCache
RecentOrderCache
ProposalLine
Store
Product
Stock
Order
SupplierOrder
...
```

Ne suppose pas que ces noms existent réellement.

**Vérifie le code.**

Pour chaque modèle/table identifié, documente :

* nom
* rôle
* colonnes importantes
* clé primaire
* relations
* index importants
* données disponibles
* fréquence de mise à jour
* source des données.

---

# 5. IDENTIFIER LES FONCTIONS MÉTIER EXISTANTES

Recherche également toutes les fonctions importantes.

Par exemple :

```text
getDailyHistory()
computeQuantityToOrder()
getSalesHistory()
getStock()
getRecentOrders()
getProposal()
generateProposal()
getLastSaleDate()
getActiveStores()
```

Encore une fois :

**ne suppose rien.**

Recherche les fonctions réellement présentes dans le code.

Pour chaque fonction importante, indique :

```text
Nom :
Fichier :
Rôle :
Paramètres :
Retour :
Tables utilisées :
Service :
Peut être réutilisée par l'assistant : Oui/Non
```

---

# 6. CRÉER UNE COUCHE "ASSISTANT TOOLS"

Si elle n'existe pas déjà, crée une couche dédiée :

```text
Assistant
    ↓
Assistant Tools
    ↓
Business Services
    ↓
Database
```

L'objectif est de ne pas coupler directement le modèle IA aux tables.

Chaque tool doit avoir au minimum :

```text
name
description
inputSchema
handler
permission
read/write
audit
```

Exemple conceptuel :

```js
{
  name: "getSalesHistory",

  description:
    "Récupère l'historique journalier des ventes d'un article dans un magasin sur une période donnée.",

  inputSchema: {
    storeId: "string",
    productId: "string",
    startDate: "string",
    endDate: "string"
  },

  permission: "READ_SALES",

  type: "READ",

  handler: salesService.getDailyHistory,

  audit: true
}
```

Le format exact doit être adapté au framework réellement utilisé dans le projet.

---

# 7. CATALOGUE INITIAL DES TOOLS

Après audit, construis un catalogue de tools adaptés au projet.

Il doit notamment couvrir les catégories suivantes.

## Produits

```text
getProduct
searchProducts
getProductDetails
```

## Magasins

```text
getStore
getStores
getActiveStores
getStoreActivity
```

## Ventes

```text
getSalesHistory
getDailySales
getSalesSummary
getLastSaleDate
```

## Stock

```text
getCurrentStock
getStockHistory
getSafetyStock
```

## Commandes

```text
getPendingOrders
getRecentOrders
getSupplierOrders
getRposOrders
```

## Réassort

```text
getProposal
getProposalLines
getCurrentSuggestedQuantity
computeReplenishment
```

## Analyse

```text
analyzeProposal
analyzeSalesTrend
analyzeStore
detectAnomalies
comparePeriods
```

## Recommandations

```text
getRecommendations
getRecommendationHistory
getRecommendationStatus
```

## Audit

```text
getAuditHistory
getDevelopmentCorrectionHistory
getUserActions
```

Ne crée que les tools réellement nécessaires.

Si une fonction existe déjà, crée simplement un wrapper contrôlé si nécessaire.

---

# 8. EXEMPLE DE MAPPING DES TOOLS

Construis un tableau de correspondance similaire à celui-ci après l'audit :

| Tool IA           | Fonction métier               | Modèle/Table       |
| ----------------- | ----------------------------- | ------------------ |
| `getSalesHistory` | `getDailyHistory()`           | `SalesLine`        |
| `getProduct`      | service produit existant      | `ProductCache`     |
| `getRecentOrders` | service commandes             | `RecentOrderCache` |
| `getProposal`     | service propositions          | `ProposalLine`     |
| `getCurrentStock` | service stock                 | table stock        |
| `analyzeProposal` | moteur de calcul + historique | plusieurs          |
| `analyzeStore`    | services magasin + ventes     | plusieurs          |

Ce tableau doit être basé sur **le vrai code du projet**.

---

# 9. PERMISSIONS

L'assistant doit respecter les permissions de l'utilisateur connecté.

La permission doit être vérifiée **dans le backend**, jamais uniquement dans le prompt de l'IA.

Exemple :

```text
Utilisateur
    ↓
Assistant
    ↓
Tool
    ↓
Permission middleware
    ↓
Business Service
    ↓
Database
```

Un utilisateur qui n'a pas accès au magasin 050 ne doit pas pouvoir demander à l'IA de récupérer ses données simplement en écrivant :

> Donne-moi les données du magasin 050.

Le backend doit refuser.

L'IA doit ensuite expliquer proprement :

> Vous n'avez pas les droits nécessaires pour consulter les données de ce magasin.

---

# 10. READ VS WRITE

Sépare clairement les tools en deux catégories.

## READ

Ils peuvent être exécutés directement si l'utilisateur possède les permissions.

Exemples :

```text
getSalesHistory
getStock
getProposal
getOrders
analyzeProposal
detectAnomalies
```

## WRITE

Ils modifient les données.

Exemples :

```text
markRecommendationApplied
ignoreRecommendation
forceProposalGeneration
modifyProposal
createOrder
```

Pour les actions WRITE, l'assistant doit demander confirmation avant exécution.

Exemple :

> Voulez-vous vraiment marquer cette recommandation comme appliquée ?

Puis seulement après confirmation :

```text
Assistant
 ↓
Confirmation utilisateur
 ↓
Write Tool
 ↓
Permission
 ↓
Business Service
 ↓
Database
 ↓
Audit Log
```

---

# 11. LOGS ET AUDIT DE L'ASSISTANT

Chaque action importante de l'assistant doit pouvoir être auditée.

Enregistrer si possible :

```text
userId
date
heure
action
tool utilisé
paramètres
résultat
succès/échec
erreur
magasin
article
IP
workstation
browser
URL
```

Attention :

ne stocke pas inutilement des données sensibles.

Les données d'audit doivent respecter les règles de sécurité existantes du projet.

---

# 12. COMPORTEMENT DE L'IA POUR UNE PROPOSITION DE RÉASSORT

Exemple :

L'utilisateur demande :

> Pourquoi l'article 123456 a une proposition de 50 ?

L'assistant doit pouvoir :

1. identifier l'article ;
2. identifier le magasin ;
3. récupérer la proposition actuelle ;
4. récupérer les calculs métier ;
5. récupérer l'historique journalier ;
6. récupérer le stock ;
7. vérifier les commandes existantes ;
8. vérifier les règles de réassort ;
9. analyser l'évolution ;
10. expliquer le résultat.

L'IA doit ensuite produire une explication claire.

Par exemple :

```text
La proposition actuelle est de 50 unités.

Sur les 10 derniers jours, les ventes montrent une moyenne de X unités/jour.

Les derniers jours montrent une évolution de X → Y → Z.

Le calcul tient également compte du stock disponible, du stock de sécurité
et du délai de réception.

Aucune commande récente ne justifie actuellement une réduction de la
quantité proposée.

La proposition de 50 unités est donc basée sur ...
```

Les chiffres doivent évidemment venir des données réelles.

---

# 13. HISTORIQUE JOURNALIER

L'analyse IA doit pouvoir consulter les ventes jour par jour.

Exemple de données :

```text
01/09 : 130
02/09 : 340
03/09 : 132
04/09 : 98
05/09 : 76
06/09 : 64
07/09 : 52
08/09 : 48
09/09 : 41
10/09 : 40
```

L'IA doit pouvoir détecter :

* tendance haussière
* tendance baissière
* stabilité
* pic inhabituel
* chute inhabituelle
* jours sans vente
* activité irrégulière
* données manquantes
* changement brutal.

Elle ne doit pas simplement calculer une moyenne.

Elle doit regarder **l'évolution dans le temps**.

---

# 14. PÉRIODE D'ANALYSE

L'assistant doit respecter les périodes déjà prévues par le projet.

Notamment si elles existent :

```text
YESTERDAY
LAST_7_DAYS
LAST_30_DAYS
CUSTOM
```

Il faut réutiliser `periodService.js` ou son équivalent réel.

Ne crée pas un deuxième système de gestion des périodes.

---

# 15. LOGIQUE 20/80

Le système doit conserver la logique métier existante des articles 20/80 / Pareto.

L'assistant doit savoir si un article :

```text
fait partie du 20/80
ne fait pas partie du 20/80
```

et adapter son analyse en conséquence.

Ne modifie pas cette logique sans justification.

---

# 16. COMMANDES EXISTANTES

Avant de recommander une nouvelle quantité, l'assistant doit vérifier si l'article est déjà commandé.

Par exemple :

```text
Article : 123456
Commande existante : Oui
Date : 08/09/2026
Quantité : 40
```

Dans ce cas, l'assistant doit en tenir compte.

Il doit pouvoir expliquer :

> Une commande récente de 40 unités existe déjà. Une nouvelle proposition doit donc être interprétée en tenant compte de cette quantité.

Si la logique métier actuelle force la quantité proposée à 0 lorsqu'une commande RPOS récente existe, l'assistant doit utiliser cette règle existante plutôt que créer une nouvelle règle.

---

# 17. ANALYSE DES MAGASINS

L'analyse ne doit pas être limitée au magasin `050`.

L'assistant doit pouvoir analyser :

```text
tous les magasins actifs
```

et identifier les cas particuliers.

Exemple :

```text
Magasin 050
Dernière activité : 09/09/2026

Magasin 051
Dernière activité : 08/09/2026

Magasin 052
Dernière activité : 15/12/2025
```

Le magasin 052 ne doit pas être traité comme un magasin normalement actif.

L'assistant doit détecter :

```text
données anciennes
activité arrêtée
absence de ventes récentes
problème d'alimentation des données
anomalie potentielle
```

et l'indiquer clairement.

---

# 18. NE PAS CONFONDRE ABSENCE DE VENTE ET MAGASIN INACTIF

Exemple :

Un article n'a aucune vente depuis 7 jours.

Cela ne signifie pas automatiquement :

> L'article ne fonctionne plus.

L'assistant doit vérifier le contexte :

* magasin actif ?
* article actif ?
* dernières ventes ?
* historique ?
* stock ?
* commande ?
* données disponibles ?
* période d'activité du magasin ?
* éventuelle rupture ?
* éventuel problème d'intégration ?

Il doit distinguer :

```text
absence réelle de vente
```

de :

```text
absence de données
```

et de :

```text
magasin inactif
```

---

# 19. DÉTECTION D'ANOMALIES

L'assistant doit pouvoir identifier les situations qui sortent de la logique habituelle.

Exemples :

```text
moyenne historique élevée
mais ventes récentes très faibles

stock élevé
mais proposition élevée

stock faible
mais proposition faible

vente exceptionnelle un seul jour

absence de ventes pendant plusieurs jours

données qui s'arrêtent brutalement

magasin actif sans nouvelles données

quantité proposée très différente du calcul historique

commande récente mais nouvelle proposition élevée
```

Dans ces situations, l'assistant doit pouvoir lancer une analyse/recalcul contrôlé.

---

# 20. RECALCUL

Si l'assistant détecte une incohérence, il doit utiliser les fonctions de calcul existantes.

Par exemple :

```text
computeQuantityToOrder()
```

ou son équivalent réel.

Il ne doit pas recréer une formule différente dans le prompt.

Le calcul métier doit rester dans le backend.

L'IA sert principalement à :

```text
comprendre
analyser
comparer
expliquer
détecter
orchestrer
```

Le moteur métier reste responsable des calculs officiels.

---

# 21. EXPLICATION DE LA DIFFÉRENCE

Si le calcul standard donne :

```text
40
```

et que la proposition finale donne :

```text
50
```

l'assistant doit être capable de répondre :

```text
Calcul standard : 40

Ajustement appliqué : +10

Raison :
...
```

Si aucune raison identifiable n'est trouvée :

```text
Je n'ai pas trouvé dans les règles actuelles une justification
suffisante pour expliquer l'écart de 10 unités.
Cette différence doit être vérifiée.
```

**Ne jamais inventer une justification.**

---

# 22. RECOMMANDATIONS

L'assistant doit pouvoir générer une liste de recommandations.

Elles doivent être classées selon des critères objectifs définis par le système, par exemple :

```text
anomalie importante
impact potentiel
données incohérentes
proposition inhabituelle
commande à vérifier
magasin à vérifier
article à vérifier
```

Ne donne pas une priorité arbitraire simplement parce que l'IA "pense" qu'un élément est important.

La priorité doit être basée sur des critères explicables.

---

# 23. RECOMMANDATIONS : APPLIQUÉ / IGNORÉ

Chaque recommandation doit pouvoir avoir un statut :

```text
À traiter
Appliquée
Ignorée
```

Lorsqu'un utilisateur clique :

```text
Marquer appliqué
```

enregistre :

```text
recommendationId
userId
date
heure
action
```

Même chose pour :

```text
Ignorer
```

L'utilisateur doit pouvoir consulter l'historique.

---

# 24. HISTORIQUE DES CORRECTIONS DÉVELOPPEMENT

Si le système détecte une erreur ou anomalie technique, il doit être possible de conserver :

```text
erreur détectée
message d'erreur exact
date
heure
module
URL
utilisateur
workstation
browser
IP
correction effectuée
date de correction
développeur
description du changement
résultat après correction
```

Exemple :

```text
Erreur détectée :
"Cannot read properties of undefined ..."

Correction :
Ajout d'une vérification avant accès à ...

Résultat :
Erreur non reproduite après correction.
```

Ne modifie pas le système de logs existant sans l'analyser d'abord.

---

# 25. GRAPHIQUES

L'assistant doit pouvoir fournir des données structurées permettant au frontend d'afficher :

* évolution des ventes
* moyenne
* tendance
* comparaison de périodes
* stock
* proposition
* commandes
* évolution journalière.

L'IA ne doit pas générer du HTML arbitraire pour les graphiques.

Elle doit retourner des données structurées.

Exemple :

```json
{
  "type": "sales_evolution",
  "labels": [
    "01/09",
    "02/09",
    "03/09"
  ],
  "values": [
    130,
    340,
    132
  ]
}
```

Le frontend est responsable du rendu.

---

# 26. RÉPONSES STRUCTURÉES

Lorsque cela est utile, l'assistant peut retourner :

```text
answer
data
analysis
recommendations
charts
sources
actions
```

Exemple conceptuel :

```json
{
  "answer": "...",

  "analysis": {
    "trend": "decreasing",
    "average": 52,
    "recentAverage": 35
  },

  "recommendations": [],

  "charts": [],

  "actions": []
}
```

Le format exact doit être adapté à l'architecture existante.

---

# 27. MÉMOIRE DE CONVERSATION

L'assistant doit comprendre le contexte de la conversation.

Exemple :

Utilisateur :

> Analyse l'article 123456 du magasin 050.

Assistant :

> ...

Utilisateur :

> Et pourquoi la quantité est 50 ?

L'assistant doit comprendre que :

```text
article = 123456
magasin = 050
```

sans demander inutilement à nouveau ces informations.

Mais la mémoire ne doit pas remplacer les données backend.

Pour les données métier actuelles, l'assistant doit toujours interroger les tools.

---

# 28. SÉCURITÉ

Ne jamais mettre :

* mot de passe
* clé API
* token
* secret
* identifiant sensible

dans le prompt système visible ou dans le frontend.

Les secrets doivent rester côté backend.

Le frontend ne doit jamais pouvoir appeler directement la base.

---

# 29. PERFORMANCE

Évite les appels inutiles.

Exemple :

Si l'utilisateur demande :

> Pourquoi la proposition de l'article 123456 est 50 ?

ne récupère pas toutes les ventes de tous les magasins.

Récupère uniquement les données nécessaires :

```text
article
magasin
proposition
historique pertinent
stock
commandes
calcul
```

Prévois également :

* pagination
* limites de période
* cache si nécessaire
* timeout
* gestion des erreurs
* logs
* limitation des appels coûteux.

---

# 30. GESTION DES ERREURS

Si un tool échoue :

```text
database unavailable
timeout
permission denied
data unavailable
invalid product
invalid store
```

l'assistant doit le savoir.

Il ne doit jamais inventer une réponse.

Exemple :

> Je n'ai pas pu récupérer l'historique des ventes du magasin 050. La source de données n'a pas répondu.

Et le backend doit journaliser l'erreur.

---

# 31. SI UNE FONCTION N'EXISTE PAS

Si l'assistant a besoin d'une information mais qu'aucune fonction existante ne permet de l'obtenir :

**ne l'invente pas.**

Indique :

```text
Donnée nécessaire :
Historique journalier des commandes fournisseur.

Fonction existante :
Aucune fonction identifiée.

Proposition :
Créer un service contrôlé getSupplierOrderHistory().
```

Puis propose son implémentation.

---

# 32. NE PAS DUPLIQUER LA LOGIQUE MÉTIER

C'est extrêmement important.

L'IA ne doit pas devenir un deuxième moteur de réassort.

La responsabilité doit être séparée :

```text
Business Engine
=
calcul officiel

AI Assistant
=
analyse + explication + orchestration
```

Exemple :

Le backend décide :

```text
quantitySuggested = 50
```

L'IA explique :

```text
Pourquoi 50 ?
```

Elle ne doit pas inventer une autre formule et dire :

```text
Moi je pense que ça devrait être 47.
```

Si elle propose une simulation, elle doit clairement dire :

```text
Simulation
```

et non :

```text
quantité officielle
```

---

# 33. AMÉLIORATION PROGRESSIVE

Le système doit être conçu pour pouvoir évoluer.

À terme, nous voulons mesurer :

```text
proposition IA
↓
validation magasin
↓
commande
↓
vente réelle
↓
résultat
↓
erreur
```

Exemple :

```text
Proposition : 50
Vente réelle : 42
Erreur : 8
```

Ces informations pourront ensuite servir à améliorer les recommandations.

Mais dans la première version :

**ne lance pas automatiquement un entraînement de modèle complexe.**

Commence par collecter proprement les données et feedbacks.

---

# 34. TESTS

Ajoute ou adapte les tests nécessaires.

Tester au minimum :

### Tools

```text
getSalesHistory
getProposal
getStock
getOrders
```

### Permissions

```text
autorisé
non autorisé
```

### Assistant

```text
question article
question magasin
question proposition
question historique
question anomalie
```

### Write actions

```text
confirmation
refus
audit
```

### Erreurs

```text
tool indisponible
DB indisponible
données absentes
```

---

# 35. DOCUMENTATION

À la fin, documente clairement :

```text
Architecture de l'assistant
Catalogue des tools
Mapping tools → services → tables
Permissions
Flux READ
Flux WRITE
Audit
Mémoire conversationnelle
Gestion des erreurs
API
Variables de configuration
Tests
```

Crée une documentation facilement compréhensible par un autre développeur.

---

# 36. ORDRE DE TRAVAIL OBLIGATOIRE

Travaille dans cet ordre.

## PHASE 1 — AUDIT

Analyse le projet sans modifier le code.

Produis :

```text
1. Architecture actuelle
2. Stack technique
3. Tables / modèles
4. Services
5. Fonctions importantes
6. Logique actuelle du réassort
7. Système IA existant
8. Authentification
9. Permissions
10. API existantes
11. Jobs
12. Points d'intégration possibles
13. Ce qui existe déjà pour l'assistant
14. Ce qui manque
```

## PHASE 2 — ARCHITECTURE PROPOSÉE

Propose :

```text
Assistant
 ↓
Tool Registry
 ↓
Permission Layer
 ↓
Business Services
 ↓
Database
```

avec un mapping complet.

## PHASE 3 — VALIDATION

Avant d'effectuer une grosse modification structurelle, présente :

```text
architecture proposée
fichiers à modifier
fichiers à créer
risques
dépendances
```

## PHASE 4 — IMPLÉMENTATION

Après validation, implémente progressivement.

Ne détruis pas le fonctionnement actuel du réassort.

## PHASE 5 — TESTS

Teste chaque couche.

## PHASE 6 — DOCUMENTATION

Documente l'architecture finale.

---

# 37. PREMIÈRE MISSION À EXÉCUTER MAINTENANT

Pour commencer :

**NE MODIFIE PAS LE CODE.**

Fais uniquement un audit du projet.

Je veux que tu recherches réellement dans le repository :

```text
- modèles
- tables
- services
- fonctions
- routes
- controllers
- repositories
- calculs
- jobs
- IA
- authentification
- permissions
- logs
- audit
```

Puis présente-moi un rapport structuré :

```text
# 1. Architecture actuelle

# 2. Tables / modèles identifiés

# 3. Fonctions métier identifiées

# 4. Logique actuelle du réassort

# 5. Données disponibles pour l'IA

# 6. Fonctions réutilisables par l'assistant

# 7. Tools à créer

# 8. Mapping Tool → Fonction → Table

# 9. Permissions

# 10. Actions READ

# 11. Actions WRITE

# 12. Architecture proposée

# 13. Fichiers à créer

# 14. Fichiers à modifier

# 15. Risques / points d'attention

# 16. Plan d'implémentation
```

**Important :**

Ne me donne pas une architecture générique basée sur des suppositions.

Je veux que ton analyse soit basée sur **le code réel du repository**.

Si tu trouves une fonction existante, montre son emplacement et explique comment l'assistant pourra l'utiliser.

Si une information manque, indique-le clairement.

Si une fonction n'existe pas, ne l'invente pas.

Pour l'instant, fais uniquement l'audit et attends ma validation avant de modifier le code.
