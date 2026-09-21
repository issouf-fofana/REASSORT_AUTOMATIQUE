Pour la proposition de commande et les commandes déjà validées, je veux mettre en place une logique d'analyse intelligente.

Une commande déjà passée par un magasin ne doit **jamais être considérée simplement comme un blocage automatique**.

Elle doit être récupérée et analysée par l'IA afin de déterminer si la quantité déjà commandée est suffisante par rapport à la consommation réelle et à la demande prévue.

### 1. Lorsqu'une commande récente existe

Exemple :

```text
Magasin : 050
Article : Produit X

Commande passée : hier
Quantité commandée : 40 unités

Ventes moyennes : 100 unités / jour
```

Lorsque le système détecte aujourd'hui que cet article nécessite potentiellement un réassort, l'IA doit d'abord vérifier les commandes déjà passées.

Elle doit constater :

> ⚠️ **Commande récente détectée**

> Vous avez commandé **40 unités hier**, alors que la consommation moyenne actuelle est d'environ **100 unités par jour**.

L'IA doit ensuite analyser l'ensemble du contexte :

* quantité commandée hier ;
* date et heure de la commande ;
* ventes avant la commande ;
* ventes depuis la commande ;
* moyenne des ventes ;
* évolution des ventes ;
* demande récente ;
* stock actuel ;
* commandes déjà en cours ;
* délai de réception si disponible ;
* historique des commandes de cet article ;
* besoin prévu pour les prochains jours.

### 2. L'IA doit déterminer si la commande existante est suffisante

Elle ne doit pas simplement faire :

```text
Commande récente = Oui
        ↓
Quantité proposée = 0
```

Elle doit plutôt faire :

```text
Commande récente
       ↓
Quantité commandée
       ↓
Analyse de la consommation
       ↓
Analyse de la demande future
       ↓
Comparaison avec le besoin
       ↓
La quantité commandée est-elle suffisante ?
       ↓
     ┌──────────────┐
     │              │
    OUI            NON
     │              │
     ↓              ↓
Pas de nouvelle   Proposer une
commande          quantité supplémentaire
```

### 3. Exemple où la commande est insuffisante

Supposons :

```text
Commande hier : 40 unités
Vente moyenne : 100 unités/jour
Stock actuel : 20 unités
Tendance : ventes en hausse
```

L'IA doit pouvoir dire :

> ⚠️ **Commande récente insuffisante**
>
> Une commande de 40 unités a été passée hier. Cependant, la consommation actuelle est d'environ 100 unités par jour et les ventes récentes montrent une demande élevée.
>
> La quantité déjà commandée ne semble pas suffisante pour couvrir le besoin prévu.
>
> **Recommandation IA : commander 80 unités supplémentaires.**

Le chiffre final doit évidemment être **calculé par l'IA à partir des données réelles**, et non fixé arbitrairement à 80.

### 4. Exemple où la commande est suffisante

Si le magasin a commandé :

```text
Commande hier : 200 unités
Vente moyenne : 80 unités/jour
Stock actuel : 100 unités
```

et que l'analyse montre que le stock + la commande couvrent suffisamment la demande prévue, l'IA doit dire :

> ✅ **Aucune nouvelle commande nécessaire pour le moment**
>
> Une commande de 200 unités a été passée hier. Après analyse du stock disponible, de la consommation récente et de la demande prévue, cette commande est actuellement suffisante.
>
> **Quantité supplémentaire recommandée : 0**

### 5. L'IA doit également contrôler si les commandes sont anormales

Je veux également que l'IA utilise **l'historique des achats/commandes** pour détecter les comportements inhabituels.

Exemple :

Historique :

```text
Commande 1 → 50 unités
Commande 2 → 60 unités
Commande 3 → 55 unités
Commande 4 → 70 unités
Commande 5 → 65 unités
```

Puis aujourd'hui :

```text
Nouvelle commande → 400 unités
```

L'IA doit détecter que **400 unités est très différent du comportement habituel**.

Elle doit générer une alerte :

> ⚠️ **Quantité de commande inhabituelle**
>
> La quantité commandée aujourd'hui est de 400 unités.
>
> L'historique des commandes de cet article montre généralement des quantités comprises entre 50 et 70 unités.
>
> Cette commande est donc nettement supérieure au comportement habituel.
>
> **Vérification recommandée.**

### 6. L'inverse doit également être détecté

Si l'historique montre :

```text
50
60
55
70
65
```

et qu'une nouvelle commande est seulement :

```text
5 unités
```

l'IA doit également détecter cette anomalie.

Elle peut afficher :

> ⚠️ **Quantité de commande inhabituellement faible**
>
> La quantité commandée est de 5 unités alors que les commandes précédentes étaient généralement comprises entre 50 et 70 unités.
>
> La consommation récente est également supérieure à cette quantité.
>
> **Vérifiez cette commande avant de poursuivre.**

### 7. Comparaison avec l'historique

L'IA doit donc pouvoir comparer une nouvelle commande avec :

* les anciennes quantités commandées ;
* la fréquence des commandes ;
* les ventes au moment de chaque commande ;
* la consommation moyenne ;
* les pics de consommation ;
* les périodes de forte ou faible activité ;
* le stock disponible ;
* les commandes encore en cours.

Elle doit essayer de comprendre **pourquoi une quantité est différente de l'habitude**.

Une différence n'est pas forcément une erreur.

Par exemple, une commande de 400 unités peut être parfaitement normale si :

* une promotion est prévue ;
* la demande augmente fortement ;
* une période particulière approche ;
* le magasin a une forte reprise d'activité ;
* un événement exceptionnel explique cette quantité.

Dans ce cas, l'IA doit prendre le contexte en compte avant de déclencher une alerte.

### 8. Les alertes doivent être mémorisées pour les prochaines analyses

Lorsqu'une anomalie de commande est détectée, je veux également que le système puisse la conserver dans l'historique d'analyse.

Par exemple :

```text
18/09/2026
Article : Produit X
Magasin : 050

Quantité commandée : 400
Quantité habituelle : 50–70

Anomalie détectée :
Quantité exceptionnellement élevée

Analyse IA :
Écart important par rapport à l'historique
```

Cela permettra au système de retrouver cette information lors des analyses futures.

Si le même type de comportement se reproduit, l'IA pourra tenir compte de cet historique.

### 9. Attention : l'IA ne doit pas accuser automatiquement l'utilisateur d'une erreur

Une anomalie signifie simplement :

> **« Cette quantité est différente du comportement habituel. »**

Elle ne doit pas automatiquement conclure :

> « La commande est incorrecte. »

Elle doit analyser le contexte et demander une vérification lorsque les données ne permettent pas de justifier clairement l'écart.

### 10. Logique globale souhaitée

Le fonctionnement du réassort doit donc devenir :

```text
Détection d'un besoin potentiel
          ↓
Recherche des commandes récentes
          ↓
Une commande existe ?
          ↓
        OUI
          ↓
Analyser la quantité commandée
          ↓
Comparer avec :
- consommation actuelle
- ventes récentes
- tendance
- stock
- demande prévue
- commandes en cours
- historique des commandes
          ↓
La commande suffit-elle ?
     ↓              ↓
    OUI            NON
     ↓              ↓
Nouvelle          Proposer une
commande = 0      quantité complémentaire
```

En parallèle :

```text
Chaque nouvelle commande
          ↓
Comparaison avec l'historique
          ↓
Détection d'un comportement inhabituel
          ↓
Analyse du contexte
          ↓
Alerte si nécessaire
          ↓
Conservation de l'anomalie
          ↓
Utilisation possible dans les analyses futures
```

### Objectif final

Je veux que l'IA puisse comprendre des situations comme :

> **« Le magasin a déjà commandé cet article hier. Il a commandé 40 unités, mais sa consommation actuelle est d'environ 100 unités par jour. Après analyse du stock, des ventes récentes, de la demande prévue et des commandes en cours, cette quantité semble insuffisante. Je recommande donc une quantité supplémentaire de X unités. »**

Et également :

> **« Une commande de 400 unités vient d'être passée. Cette quantité est nettement supérieure aux quantités habituellement commandées pour cet article. J'ai vérifié l'évolution des ventes et le contexte disponible, mais l'écart reste inhabituel. Je déclenche donc une alerte pour vérification. »**

Le système doit donc analyser **à la fois les besoins futurs et les décisions de commande déjà prises**.

Les commandes passées deviennent ainsi une source d'information importante pour l'IA, aussi bien pour **éviter les surcommandes** que pour **détecter les sous-commandes et les comportements inhabituels**.

---

## Chantier futur : gestion des DLC/DLV (dates limites de consommation/vente) dans le réassort

**Statut : à démarrer, bloqué faute d'accès réseau (19/09/2026).**

### Contexte

L'utilisateur a confirmé que les DLV (dates limites de vente) sont disponibles côté API RPOS —
**endpoint identifié le 21/09/2026** : `end_of_life_product` (vu via l'URL d'administration RPOS :
`https://pos1-prod-prosuma.prosuma.pos/administration/#!/end_of_life_product?page=1&created_at_0=...&created_at_1=...&is_deleted=false&page_size=250&search_options_view=normal`).
Reste à explorer l'API REST correspondante (probablement `/api/end_of_life_product/`, à confirmer —
même convention que les autres endpoints déjà utilisés dans rposClient.js, ex: `/api/product/`,
`/api/product_addressing/`) une fois l'accès réseau RPOS disponible : structure exacte des champs
(date de péremption par lot ou par article ?, quantité concernée, lien avec ProductCache.ean).

### Pourquoi c'est important (analyse du 19/09/2026)

Identifié comme la plus grosse lacune métier de l'Assistant IA / du calcul de réassort : aucune
notion de péremption n'existe nulle part dans le système actuel (confirmé par recherche dans tout
le code — `proposalService.js`, `chatbotToolsService.js`, schéma Prisma). Le calcul de quantité à
commander (`computeQuantityToOrder`, proposalService.js) ne connaît que la vente moyenne, le stock
et les commandes en cours — il peut donc proposer une quantité qui semble cohérente avec la
demande, mais qui expose le magasin à de la perte sèche si l'article est périssable et proche de sa
DLC (le stock ne sera jamais vendu avant péremption, quelle que soit la demande théorique).

### Ce qu'il faudra faire une fois l'accès réseau rétabli

1. **Explorer l'API RPOS** pour trouver l'endpoint/champ exposant les DLV par lot ou par article
   (probablement `/api/product/` avec un champ dédié, ou un endpoint séparé type
   `/api/stock_batch/` ou `/api/expiry/` — à confirmer, aucune certitude à ce stade).
2. Déterminer si la DLV est suivie **par lot de réception** (plusieurs dates possibles pour un même
   article selon les livraisons successives) ou **par article seul** (une seule date, plus simple
   mais moins précis) — ça détermine toute l'architecture de stockage côté base.
3. **Décider du périmètre v1** : probablement démarrer par un nouveau tool chatbot
   (`getExpiringArticles` ou similaire, sur le modèle de `getStockoutRisks`/`getOverstockArticles`)
   avant d'intégrer la DLC dans le calcul de proposition lui-même (chantier plus lourd, touche
   `computeQuantityToOrder` et le cœur du calcul).
4. Vérifier si un nouveau modèle Prisma est nécessaire (ex: `ProductExpiry` ou champ ajouté à
   `ProductCache`) ou si l'info peut rester en lecture directe RPOS à la demande, sans persistance
   locale (dépend du volume et de la fraîcheur nécessaire).

### Rappel des autres lacunes métier identifiées le même jour (non traitées, par ordre d'impact)

2. Aucune anticipation d'impact promo sur le réassort (une promo à venir devrait ajuster la
   quantité proposée à l'avance, pas seulement signaler qu'une promo est en cours).
3. Aucune vue consolidée de la casse/démarque (uniquement article par article sur demande,
   `getStockMoveHistory` — pas de KPI global "quel rayon perd le plus").
4. Aucune analyse de fiabilité fournisseur (retards de livraison récurrents, taux de rupture par
   fournisseur).
5. Aucune anticipation calendaire/événementielle proactive (Ramadan, Noël, rentrée...) au-delà de
   l'ajustement de saisonnalité déjà basé sur l'historique.
