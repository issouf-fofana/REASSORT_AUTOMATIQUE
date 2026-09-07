# CAHIER DES CHARGES

## Projet de réassort automatique intelligent des magasins

**Version :** 1.0
**Date :** 22 août 2026
**Objet :** Conception d’un système intelligent de proposition de commandes pour les magasins

---

## 1. Contexte

Actuellement, la gestion du réassort des magasins repose principalement sur une analyse manuelle des stocks disponibles. Les responsables magasin consultent leur stock et déterminent les quantités à commander.

Cette méthode présente plusieurs limites :

* absence d'analyse systématique des ventes ;
* commandes basées principalement sur le stock disponible ;
* difficulté à anticiper les besoins réels du magasin ;
* risque de rupture de stock ;
* risque de surstock ;
* absence de prise en compte systématique de la saisonnalité ;
* temps important consacré à la préparation des commandes.

L'objectif du projet est donc de mettre en place un **système intelligent de réassort** permettant de proposer automatiquement au magasin les articles et quantités à commander en fonction des ventes historiques, du stock disponible et progressivement de facteurs complémentaires comme la saisonnalité.

Le principe est simple :

> **Ne plus commander uniquement en fonction de ce qu'il reste en stock, mais déterminer ce qu'il faut commander en fonction de ce que le magasin vend réellement.**

---

# 2. Objectifs du projet

## 2.1 Objectif principal

Développer un système permettant de générer automatiquement une **proposition de commande hebdomadaire** pour chaque magasin.

Cette proposition devra permettre de couvrir les besoins prévisionnels du magasin tout en limitant les ruptures et le surstock.

## 2.2 Objectifs secondaires

Le système devra progressivement permettre de :

* analyser les ventes historiques ;
* identifier les articles les plus importants du magasin ;
* déterminer les articles représentant environ 80 % du chiffre d'affaires ;
* calculer les ventes moyennes hebdomadaires ;
* prendre en compte le stock disponible ;
* calculer les quantités à commander ;
* générer automatiquement une proposition de commande ;
* permettre au magasin de contrôler et valider la proposition ;
* transmettre la commande au système de commande existant ;
* prendre en compte la saisonnalité ;
* améliorer progressivement la précision des propositions.

---

# 3. Principe des 20/80

La première étape du projet sera basée sur le principe de Pareto, communément appelé **règle des 20/80**.

L'objectif est d'identifier les articles qui génèrent la majorité du chiffre d'affaires du magasin.

Par exemple, pour un assortiment de 10 articles :

| Article    | Chiffre d'affaires |
| ---------- | -----------------: |
| Article 1  |        70 000 FCFA |
| Article 2  |        90 000 FCFA |
| Article 3  |         5 000 FCFA |
| Article 4  |         5 000 FCFA |
| Article 5  |         5 000 FCFA |
| Article 6  |         5 000 FCFA |
| Article 7  |         5 000 FCFA |
| Article 8  |         5 000 FCFA |
| Article 9  |         5 000 FCFA |
| Article 10 |         5 000 FCFA |
| **Total**  |   **200 000 FCFA** |

Le système devra classer les articles par chiffre d'affaires décroissant et calculer leur contribution cumulée.

Les articles représentant environ **80 % du chiffre d'affaires** seront identifiés comme les articles prioritaires.

> Important : le système ne devra pas considérer mécaniquement que 20 % des articles représentent toujours exactement 80 % du chiffre d'affaires. Il devra calculer la réalité observée dans les données.

---

# 4. Données nécessaires

Pour fonctionner correctement, le système devra disposer au minimum des données suivantes.

## 4.1 Assortiment du magasin

L'assortiment correspond à la liste des articles disponibles dans le magasin.

Données nécessaires :

* code article ;
* désignation article ;
* catégorie ;
* fournisseur ;
* unité de vente ;
* magasin concerné ;
* statut de l'article.

## 4.2 Historique des ventes

Le système devra récupérer les ventes du magasin sur une période suffisamment longue.

### Période minimale recommandée

**12 mois d'historique.**

Une période supérieure à 12 mois sera préférable afin de permettre l'analyse de la saisonnalité.

Données nécessaires :

* date de vente ;
* magasin ;
* code article ;
* quantité vendue ;
* chiffre d'affaires ;
* prix de vente ;
* éventuellement promotions et remises.

## 4.3 Stock

Le système devra également connaître l'état actuel du stock.

Données nécessaires :

* stock disponible ;
* stock réservé ;
* stock en commande ;
* stock minimum éventuel ;
* stock maximum éventuel ;
* date de dernière réception.

### Gestion des stocks négatifs (anomalie de suivi)

Un stock négatif dans le système source signifie que l'article continue d'être vendu alors que le
stock enregistré indique qu'il n'y en a plus : le stock affiché n'est donc plus synchronisé avec la
réalité physique du magasin (démarque non enregistrée, réception non saisie, erreur de saisie, etc.).

**Ce système de réassort automatique ne corrige jamais lui-même ce stock.** La remise à jour ne peut
provenir que de deux événements côté système source (RPOS) :

* une **intégration de facture** — la réception d'une commande fournisseur, qui recrédite le stock ;
* un **inventaire physique** — un comptage manuel qui recale le stock système sur le stock réel.

Tant que l'un de ces deux événements n'a pas eu lieu, le stock reste négatif et n'est pas fiable pour
cet article. Deux comportements sont possibles, configurables par magasin :

* **Stock ramené à 0 avant calcul** (comportement par défaut) : la quantité proposée est calculée
  uniquement sur la vente moyenne et le stock de sécurité, sans jamais soustraire un stock négatif —
  l'article reste malgré tout éligible à la proposition puisqu'il continue de générer du chiffre
  d'affaires. La page de validation signale ces articles avec un badge "Stock non fiable", met en
  évidence leur dernier achat et leur dernière vente, et affiche un compteur global du nombre
  d'articles concernés, pour orienter le responsable magasin vers un inventaire ou une vérification
  de réception.
* **Stock négatif conservé tel quel** : le déficit réel s'ajoute à la quantité à commander, au risque
  de sur-commander si le stock négatif ne reflète pas un vrai déficit physique.

---

# 5. Analyse des ventes

Pour chaque magasin, le système devra analyser l'historique des ventes.

Les indicateurs principaux seront :

* chiffre d'affaires annuel ;
* chiffre d'affaires mensuel ;
* chiffre d'affaires hebdomadaire ;
* quantité vendue ;
* moyenne des ventes hebdomadaires ;
* fréquence de vente ;
* évolution des ventes ;
* contribution de chaque article au chiffre d'affaires.

Le système devra ensuite classer les articles par importance.

---

# 6. Calcul de la demande hebdomadaire

La commande étant prévue sur une base hebdomadaire, le système devra déterminer le besoin hebdomadaire du magasin.

Exemple :

Un article vend en moyenne :

**100 unités par semaine.**

Le magasin possède actuellement :

**30 unités.**

Le besoin prévisionnel est donc de :

**100 - 30 = 70 unités.**

Le système pourra alors proposer une commande de **70 unités**, sous réserve des règles métier qui seront définies.

---

# 7. Principe du réassort automatique

Le principe général sera :

**Besoin prévisionnel + stock cible - stock disponible - stock déjà commandé = quantité à commander**

Exemple :

* besoin prévu pour la semaine : 100 unités ;
* stock disponible : 30 unités ;
* stock déjà en commande : 10 unités ;
* stock de sécurité : 20 unités.

Calcul :

**100 + 20 - 30 - 10 = 80 unités**

La proposition de commande sera donc de :

**80 unités.**

Les règles exactes de calcul devront être définies avec les équipes métier.

---

# 8. Prise en compte de la saisonnalité

La première version du projet pourra fonctionner principalement avec les ventes historiques.

Dans une deuxième phase, le système devra intégrer la saisonnalité.

Certains produits connaissent en effet des variations importantes selon les périodes de l'année.

Exemple :

Le chocolat peut connaître une forte augmentation des ventes pendant la période de Pâques.

Le système devra donc comparer :

* ventes actuelles ;
* ventes de la même période l'année précédente ;
* historique des années précédentes ;
* tendances récentes ;
* événements commerciaux ;
* promotions éventuelles.

L'objectif est d'éviter une situation dans laquelle le système recommande une quantité uniquement basée sur la moyenne récente alors qu'une période de forte demande approche.

### Implémentation (comparaison N vs N-1)

Une première version du mécanisme de saisonnalité est en place, activable par magasin dans les
Paramètres (désactivée par défaut).

Quand elle est activée, la génération de proposition compare la période d'analyse actuelle à la
même période N années en arrière (nombre d'années configurable). Si la quantité vendue sur cette
période N-1 diffère de la période actuelle au-delà d'un seuil configurable, la vente moyenne
prévue est ajustée vers la valeur constatée N-1, plutôt que de se baser uniquement sur la moyenne
récente.

Points importants :

* la comparaison se base toujours sur la **période de référence du magasin** (dernière vente
  réelle connue), jamais sur la date système — le mécanisme reste donc valable aussi bien sur un
  magasin de test aux données anciennes qu'en production sur un magasin actif ;
* si aucune donnée n'existe pour la période N-1 (historique insuffisant), l'ajustement est
  simplement ignoré pour cette génération, sans erreur ni blocage ;
* les articles dont la prévision a été ajustée sont signalés visuellement (badge "Saisonnalité")
  sur la page de validation, avec l'écart constaté par rapport à N-1.

---

# 9. Génération de la proposition de commande

Le système devra générer automatiquement une **proposition de commande hebdomadaire** pour chaque magasin.

La proposition devra présenter au minimum :

| Article   | Stock | Vente moyenne/semaine | Besoin prévu | Quantité proposée |
| --------- | ----: | --------------------: | -----------: | ----------------: |
| Article A |    20 |                   100 |          100 |               100 |
| Article B |    50 |                    70 |           70 |                40 |
| Article C |    10 |                    20 |           20 |                10 |

Le responsable magasin pourra consulter cette proposition avant validation.

---

# 10. Validation par le magasin

La commande ne devra pas être automatiquement envoyée dans la première version.

Le processus sera :

**Analyse des ventes → Proposition → Contrôle magasin → Modification éventuelle → Validation → Transmission**

Le responsable magasin devra pouvoir :

* accepter la quantité proposée ;
* modifier une quantité ;
* supprimer un article ;
* ajouter éventuellement un article ;
* valider la proposition complète.

L'objectif est de conserver un **contrôle humain** pendant la phase de déploiement.

---

# 11. Gestion des commandes par rayon

Les commandes devront être séparées selon les rayons concernés.

Le système devra donc être capable de regrouper les articles par rayon et de générer les commandes correspondantes.

Exemple :

### Rayon Épicerie

* Article A
* Article B
* Article C

### Rayon Boissons

* Article D
* Article E

### Rayon Produits frais

* Article F
* Article G

Chaque commande devra respecter les règles et le processus existants dans l'entreprise.

---

# 12. Intégration avec le système existant

Une étude devra être réalisée afin de déterminer les possibilités d'intégration avec le système actuellement utilisé pour les commandes.

Deux possibilités devront être étudiées.

### Option 1 — Intégration API

Le système de réassort communique directement avec le système existant via une API.

Avantages :

* automatisation ;
* réduction des manipulations ;
* meilleure fiabilité ;
* expérience utilisateur simplifiée ;
* intégration directe dans l'environnement existant.

Le magasin pourrait simplement voir :

> **Proposition de commande disponible**

puis consulter et valider la proposition.

### Option 2 — Système intermédiaire

Si aucune API exploitable n'est disponible, une solution intermédiaire pourra être développée.

Le système générera la commande puis permettra son export dans le format attendu par le système existant.

Cette solution devra être considérée comme une solution transitoire si une intégration API est techniquement possible.

---

# 13. Étude technique préalable

Avant le développement complet, une étude devra être réalisée sur le système existant afin de déterminer :

* quelles données sont disponibles ;
* comment récupérer les ventes ;
* comment récupérer les stocks ;
* comment récupérer l'assortiment ;
* comment récupérer les commandes ;
* quelles API sont disponibles ;
* quels formats d'échange sont disponibles ;
* comment créer une commande ;
* comment séparer les commandes par rayon ;
* comment récupérer le statut d'une commande ;
* quelles règles métier sont actuellement utilisées.

Cette étude est indispensable avant de définir définitivement l'architecture technique.

---

# 14. Immersion en magasin

Une étape importante du projet sera une **immersion en magasin**.

L'objectif est de comprendre le fonctionnement réel du processus de commande.

Il faudra notamment observer :

* comment le responsable consulte actuellement son stock ;
* comment il identifie les articles à commander ;
* comment il détermine les quantités ;
* comment les commandes sont préparées ;
* comment elles sont séparées par rayon ;
* comment elles sont transmises ;
* comment elles sont validées ;
* quels problèmes sont rencontrés ;
* quelles informations manquent actuellement aux responsables magasin.

Cette immersion permettra d'éviter de développer une solution uniquement basée sur une vision technique du processus.

---

# 15. Architecture fonctionnelle cible

Le fonctionnement cible pourra être représenté ainsi :

**Données magasins**

↓

**Ventes historiques**

↓

**Analyse des ventes**

↓

**Classification 20/80**

↓

**Calcul de la demande hebdomadaire**

↓

**Analyse du stock**

↓

**Prise en compte des commandes en cours**

↓

**Calcul du besoin**

↓

**Prise en compte de la saisonnalité**

↓

**Génération de la proposition de commande**

↓

**Validation par le magasin**

↓

**Création des commandes par rayon**

↓

**Transmission au système existant**

---

# 16. Historisation

Toutes les propositions devront être historisées.

Pour chaque proposition, il faudra conserver :

* magasin ;
* date ;
* articles proposés ;
* quantités proposées ;
* quantités modifiées ;
* quantités finalement commandées ;
* utilisateur ayant validé ;
* date de validation ;
* statut de la commande.

Cette historisation permettra d'analyser les performances du système.

---

# 17. Indicateurs de performance

Le projet devra permettre de mesurer son efficacité.

Les principaux KPI seront :

### Disponibilité produit

Mesurer la réduction des ruptures de stock.

### Taux de rupture

Comparer le taux de rupture avant et après mise en place du système.

### Taux de surstock

Identifier les produits commandés en quantité excessive.

### Précision des prévisions

Comparer :

**quantité prévue vs quantité réellement vendue.**

### Taux d'acceptation des propositions

Mesurer le nombre de propositions validées sans modification.

### Taux de modification

Mesurer les propositions modifiées par les magasins.

### Chiffre d'affaires

Analyser l'évolution du chiffre d'affaires des articles concernés.

---

# 18. Phasage du projet

## Phase 1 — Compréhension métier

* immersion en magasin ;
* analyse du processus actuel ;
* identification des acteurs ;
* identification des règles métier ;
* identification des problèmes actuels.

## Phase 2 — Étude des données

* récupération de l'assortiment ;
* récupération des ventes ;
* récupération des stocks ;
* récupération des commandes ;
* analyse de la qualité des données.

## Phase 3 — Prototype 20/80

Développer un premier prototype permettant :

* d'importer les ventes ;
* de classer les articles ;
* de calculer le chiffre d'affaires ;
* d'identifier les articles représentant environ 80 % du CA ;
* de produire des indicateurs par magasin.

## Phase 4 — Prototype de réassort

Ajouter :

* ventes hebdomadaires ;
* stock disponible ;
* stock cible ;
* calcul du besoin ;
* proposition de commande.

## Phase 5 — Validation magasin

Permettre au responsable magasin :

* de consulter ;
* modifier ;
* valider les propositions.

## Phase 6 — Intégration

Étudier puis mettre en œuvre l'intégration avec le système existant, idéalement via API.

## Phase 7 — Saisonnalité

Ajouter :

* comparaison avec l'année précédente ;
* tendances saisonnières ;
* événements commerciaux ;
* promotions.

## Phase 8 — Automatisation avancée

À terme :

**Analyse → proposition → validation → commande**

avec un niveau d'automatisation progressivement augmenté.

---

# 19. Évolution cible

Le système devra être conçu de manière évolutive.

### Version 1

**Ventes + 20/80**

Objectif : comprendre quels articles sont réellement importants.

### Version 2

**Ventes + stock + besoin hebdomadaire**

Objectif : générer une proposition de commande.

### Version 3

**Ventes + stock + saisonnalité**

Objectif : améliorer la précision des propositions.

### Version 4

**Intégration API**

Objectif : intégrer directement le processus dans le système existant.

### Version 5

**Automatisation avancée**

Objectif à terme :

> Le système analyse les données, génère la proposition, le magasin valide et la commande est automatiquement transmise.

---

# 20. Prérequis

Avant le développement, les éléments suivants devront être disponibles :

* accès aux données de ventes ;
* accès aux données de stock ;
* accès à l'assortiment ;
* accès aux historiques de commandes ;
* documentation technique du système existant ;
* documentation ou accès aux API disponibles ;
* identification des responsables magasin ;
* définition des règles de commande ;
* immersion dans plusieurs magasins.

---

# 21. Risques identifiés

### Qualité des données

Des données de ventes ou de stock incorrectes entraîneraient des propositions incorrectes.

### Règles métier non documentées

Les pratiques actuelles des magasins devront être identifiées avant automatisation.

### Absence d'API

Une absence d'API pourrait nécessiter une solution d'intégration intermédiaire.

### Adoption par les magasins

Les responsables magasin devront conserver un contrôle sur les commandes pendant la phase initiale.

### Saisonnalité

Une simple moyenne des ventes ne sera pas suffisante pour certains produits.

---

# 22. Critères de réussite

Le projet sera considéré comme réussi lorsque :

* les ventes historiques sont correctement exploitées ;
* les articles importants sont identifiés automatiquement ;
* le système calcule une demande hebdomadaire ;
* le stock disponible est intégré dans le calcul ;
* une proposition de commande est générée automatiquement ;
* le magasin peut contrôler et modifier cette proposition ;
* les commandes peuvent être séparées par rayon ;
* les commandes validées peuvent être transmises au système existant ;
* les propositions sont historisées ;
* les ruptures et le surstock peuvent être mesurés ;
* le système peut évoluer vers la prise en compte de la saisonnalité.

---

# 23. Conclusion

Le projet consiste à passer d'un modèle de commande principalement basé sur l'observation manuelle du stock à un modèle de **réassort piloté par la donnée**.

La première étape sera volontairement simple :

> **Analyser les ventes sur au moins une année et identifier les articles qui génèrent la majorité du chiffre d'affaires.**

Le système évoluera ensuite vers :

> **Ventes + stock + demande hebdomadaire + saisonnalité → proposition de commande.**

Le magasin restera dans un premier temps responsable de la validation de la commande.

L'objectif final est de disposer d'un système intégré au processus existant permettant aux magasins de recevoir automatiquement une proposition de commande pertinente, de la contrôler et de la valider, tout en réduisant les ruptures et les surstocks.

**Principe directeur du projet :**

> **Ne plus demander au magasin uniquement "qu'est-ce qui reste en stock ?", mais lui proposer "voici ce que tu dois commander pour couvrir tes ventes prévisionnelles".**


# 24. Gestion des magasins et cloisonnement des données

Le système devra être conçu selon une architecture **multi-magasins**.

Chaque magasin sera identifié de manière unique par :

* un code magasin ;
* un nom magasin ;
* un serveur associé.

Chaque magasin disposera de son propre compte utilisateur permettant d'accéder à son espace de gestion.

## 24.1 Référentiel des magasins

Le système devra intégrer le référentiel suivant :

| Serveur                | Code magasin | Nom magasin                 |
| ---------------------- | -----------: | --------------------------- |
| Serveur Prosuma Prod4  |           35 | HYPER HAYAT                 |
| Serveur Prosuma Prod1  |           50 | CASH CENTER ZONE 4          |
| Serveur Prosuma Prod9  |           80 | MANDARINE MARCORY           |
| Serveur Prosuma Prod5  |          100 | CASINO 2 PLATEAUX           |
| Serveur Prosuma Prod1  |          110 | SUPER U VALLON              |
| Serveur Prosuma Prod2  |          120 | MANDARINE GOLF              |
| Serveur Prosuma Prod6  |          220 | SUPER U PLATEAU             |
| Serveur Prosuma Prod3  |          230 | HYPER CASINO PRIMA          |
| Serveur Prosuma Prod7  |          235 | SUPER U DJIBI               |
| Serveur Prosuma Prod8  |          240 | FNAC CAP SUD                |
| Serveur Prosuma Prod8  |          245 | FNAC CAP NORD               |
| Serveur Prosuma Prod8  |          250 | GIFI Z4                     |
| Serveur Prosuma Prod8  |          261 | MONOP COCODY                |
| Serveur Prosuma Prod2  |          281 | CASINO MANDARINE ANGRE      |
| Serveur Prosuma Prod10 |          290 | MANDARINE BIETRY            |
| Serveur Prosuma Prod9  |          291 | MANDARINE DANGA             |
| Serveur Prosuma Prod9  |          292 | MANDARINE KOUMASSI          |
| Serveur Prosuma Prod9  |          293 | MANDARINE AMBASSADE CHINE   |
| Serveur Prosuma Prod2  |          294 | CASINO MANDARINE RIVIERA 4  |
| Serveur Prosuma Prod11 |          295 | CASINO ALLABRA              |
| Serveur Prosuma Prod12 |          301 | S2P SOCOCE ZONE 3           |
| Serveur Prosuma Prod13 |          302 | S2P HYPER U                 |
| Serveur Prosuma Prod15 |          303 | S2P SOCOCE BOUAKE           |
| Serveur Prosuma Prod14 |          304 | S2P SOCOCE DALOA            |
| Serveur Prosuma Prod12 |          305 | S2P SOCOCE RUE DES JARDINS  |
| Serveur Prosuma Prod14 |          306 | S2P SOCOCE YAMOUSSOKRO      |
| Serveur Prosuma Prod15 |          307 | S2P SOCOCE GAGNOA           |
| Serveur Prosuma Prod12 |          308 | S2P SOCOCE ABOBO            |
| Serveur Prosuma Prod15 |          309 | S2P SUPERETTE SOCOCE BOUAKE |
| Serveur Prosuma Prod14 |          310 | S2P ECOMARCHE SAN PEDRO     |
| Serveur Prosuma Prod12 |          311 | SOCOCE CHATEAU EAU          |
| Serveur Prosuma Prod15 |          312 | S2P SOCOCE RIVIERA          |
| Serveur Prosuma Prod14 |          313 | S2P SOCOCE ANANI            |
| Serveur Prosuma Prod17 |          353 | CASH IVOIRE U ANGRE         |
| Serveur Prosuma Prod18 |          354 | CASH IVOIRE U TOITS ROUGES  |
| Serveur Prosuma Prod17 |          356 | CASH IVOIRE U COCODY        |
| Serveur Prosuma Prod18 |          357 | CASH IVOIRE U REMBLAIS      |
| Serveur Prosuma Prod17 |          364 | CASH IVOIRE U 7 DECEMBRE    |
| Serveur Prosuma Prod18 |          368 | CASH IVOIRE U SADIGUIBA     |
| Serveur Prosuma Prod16 |          371 | CASH IVOIRE ANANERAIE       |
| Serveur Prosuma Prod18 |          372 | CASH IVOIRE U MAROC         |
| Serveur Prosuma Prod18 |          376 | CASH IVOIRE U SICOGI ANGRE  |
| Serveur Prosuma Prod18 |          378 | CASH IVOIRE DJE KONAN       |
| Serveur Prosuma Prod17 |          410 | CASH IVOIRE U BESSIKOI      |
| Serveur Prosuma Prod17 |          411 | CASH IVOIRE U ANTENNE       |
| Serveur Prosuma Prod16 |          412 | CASH IVOIRE DOKUI           |
| Serveur Prosuma Prod17 |          413 | CASH IVOIRE U AGOUTI        |
| Serveur Prosuma Prod16 |          414 | CASH IVOIRE U PORT-BOUËT    |
| Serveur Prosuma Prod16 |          415 | CASH IVOIRE U M'BADON       |
| Serveur Prosuma Prod16 |          416 | CASH IVOIRE U LATRILLE      |
| Serveur Prosuma Prod16 |          417 | CASH IVOIRE U BINGERVILLE   |

---

# 25. Gestion des comptes utilisateurs

Chaque magasin devra disposer d'un ou plusieurs comptes utilisateurs.

Un compte utilisateur sera rattaché à un magasin précis.

Exemple :

**Compte :** responsable_hayat
**Magasin :** HYPER HAYAT
**Code magasin :** 35
**Serveur :** Serveur Prosuma Prod4

Le système devra automatiquement associer l'utilisateur à son magasin.

---

# 26. Cloisonnement des données

Le cloisonnement des données constitue une exigence de sécurité majeure.

Un utilisateur rattaché au magasin **HYPER HAYAT** ne devra voir que :

* les ventes de HYPER HAYAT ;
* le stock de HYPER HAYAT ;
* l'assortiment de HYPER HAYAT ;
* les propositions de commande de HYPER HAYAT ;
* les commandes de HYPER HAYAT ;
* l'historique des commandes de HYPER HAYAT.

Il ne devra en aucun cas pouvoir accéder aux données de :

* CASH CENTER ZONE 4 ;
* MANDARINE MARCORY ;
* SUPER U VALLON ;
* ou de tout autre magasin.

Cette restriction devra être appliquée **au niveau du backend et de la base de données**, et pas uniquement au niveau de l'interface.

---

# 27. Espace magasin

Après authentification, l'utilisateur sera automatiquement redirigé vers l'espace correspondant à son magasin.

Exemple :

### HYPER HAYAT

Le responsable se connecte et arrive sur :

**Tableau de bord HYPER HAYAT**

Il pourra consulter :

* chiffre d'affaires ;
* ventes ;
* stock ;
* articles prioritaires ;
* proposition de commande ;
* commandes en cours ;
* historique des commandes.

Le magasin ne devra pas avoir besoin de sélectionner manuellement son magasin.

Le magasin sera déterminé automatiquement à partir du compte connecté.

---

# 28. Proposition de commande par magasin

Chaque magasin disposera de ses propres propositions.

Exemple :

### HYPER HAYAT

**Proposition de commande — Semaine 34**

| Article   | Stock | Ventes prévues | Quantité proposée |
| --------- | ----: | -------------: | ----------------: |
| Article A |    10 |             50 |                40 |
| Article B |    20 |             80 |                60 |
| Article C |     5 |             30 |                25 |

Le responsable de HYPER HAYAT pourra :

* consulter la proposition ;
* modifier les quantités ;
* supprimer une ligne ;
* valider la commande.

---

# 29. Sécurité et contrôle d'accès

Le système devra mettre en place une gestion des droits basée sur les rôles.

## Profil magasin

Accès uniquement aux données de son magasin.

## Profil administrateur

Accès à l'ensemble des magasins.

L'administrateur pourra notamment :

* consulter tous les magasins ;
* consulter les ventes ;
* consulter les stocks ;
* consulter les propositions ;
* suivre les validations ;
* suivre les commandes ;
* gérer les utilisateurs ;
* consulter les statistiques globales.

## Profil superviseur

Un profil intermédiaire pourra éventuellement être créé pour permettre à certains responsables de suivre plusieurs magasins.

---

# 30. Règle fondamentale de sécurité

La règle suivante devra être respectée :

> **Un utilisateur magasin ne peut accéder qu'aux données du magasin auquel son compte est rattaché.**

Cette règle devra être appliquée sur toutes les fonctionnalités :

* ventes ;
* stocks ;
* assortiment ;
* propositions ;
* commandes ;
* historique ;
* statistiques ;
* API.

Même si un utilisateur tente de modifier manuellement l'URL ou les paramètres d'une requête, le backend devra refuser l'accès aux données d'un autre magasin.

---

# 31. Architecture logique des données

Chaque donnée métier devra être rattachée à un magasin.

Exemple :

**Magasin**

→ Code magasin
→ Nom magasin
→ Serveur

**Utilisateur**

→ Compte utilisateur
→ Magasin associé
→ Rôle

**Vente**

→ Magasin
→ Article
→ Date
→ Quantité
→ Chiffre d'affaires

**Stock**

→ Magasin
→ Article
→ Quantité disponible

**Proposition**

→ Magasin
→ Semaine
→ Article
→ Quantité proposée
→ Statut

**Commande**

→ Magasin
→ Rayon
→ Articles
→ Quantités
→ Statut

Cette relation permettra d'assurer le cloisonnement entre les magasins.

---

# 32. Tableau de bord administrateur

Un tableau de bord central pourra être prévu pour les équipes habilitées.

Il permettra d'avoir une vision globale :

* nombre de magasins actifs ;
* magasins ayant une proposition disponible ;
* propositions validées ;
* propositions en attente ;
* commandes générées ;
* commandes transmises ;
* taux de modification des propositions ;
* ruptures ;
* chiffre d'affaires ;
* performances par magasin.

L'accès à ce tableau de bord sera strictement réservé aux profils autorisés.

---

# 33. Scénario utilisateur cible

### Étape 1 — Connexion

Le responsable du magasin se connecte avec son compte.

### Étape 2 — Identification automatique

Le système identifie automatiquement :

**Utilisateur → Magasin → Serveur**

### Étape 3 — Tableau de bord

Le responsable accède uniquement à l'espace de son magasin.

### Étape 4 — Proposition

Le système affiche la proposition de commande de la semaine.

### Étape 5 — Contrôle

Le responsable vérifie les articles et les quantités.

### Étape 6 — Modification éventuelle

Il peut ajuster certaines quantités.

### Étape 7 — Validation

Il valide la proposition.

### Étape 8 — Génération des commandes

Le système crée les commandes nécessaires, notamment par rayon.

### Étape 9 — Transmission

La commande est transmise au système existant via API ou via le mécanisme d'intégration retenu.

### Étape 10 — Historisation

L'ensemble du processus est enregistré afin de permettre un suivi et un audit.

---

# 34. Exigence fonctionnelle majeure

Le système devra fonctionner selon le principe :

> **1 compte → 1 magasin → accès aux données de ce magasin uniquement.**

Une exception sera prévue pour les profils administrateurs ou superviseurs explicitement autorisés à consulter plusieurs magasins.

Cette architecture permettra de déployer progressivement la solution sur l'ensemble des magasins tout en garantissant la confidentialité et l'intégrité des données.

Ce qu'il reste à faire (rappel de la liste précédente)
#	Tâche	Statut
1	Séparation commandes par rayon (§11)	⏳ à faire — department RPOS confirmé exploitable
2	KPI rupture/surstock	✅ fait
3	Tableau de bord admin centralisé (§32)	⏳ prochain sur la liste
4	Précision des prévisions (prévu vs vendu)	⏳ à faire
5	Rôle superviseur (§29)	⏳ à faire
6	Saisonnalité (§8)	⏳ bloqué par le manque d'historique de données

