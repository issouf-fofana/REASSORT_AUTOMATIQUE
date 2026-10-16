from pathlib import Path

readme = """# Dashboard de suivi et d’analyse des ruptures de stock — PROSUMA

## 1. Présentation

Ce projet vise à mettre en place un tableau de bord permettant de détecter, suivre et analyser les ruptures de stock dans les magasins PROSUMA.

L’objectif est de répondre à quatre questions principales :

- Quels articles sont en rupture ?
- Depuis combien de temps chaque article est-il en rupture ?
- Quelle est la cause probable de la rupture et à quelle étape se situe le problème ?
- Quels rayons sont les plus touchés et quelles sont les pertes potentielles associées ?

Le tableau de bord doit rapprocher les données de **Cyrus** (entrepôt) et d’**Asten** (magasins), sous réserve de la disponibilité et de la qualité des données nécessaires.

## 2. Objectifs fonctionnels

### 2.1 Suivi des ruptures

- Détecter les articles dont le stock magasin est nul ou négatif.
- Identifier les articles actifs et réellement attendus dans chaque magasin.
- Enregistrer la date et l’heure de début de la rupture.
- Calculer la durée de rupture, en heures ou en jours.
- Suivre les ruptures en cours et les ruptures résolues.
- Conserver un historique des stocks afin d’expliquer les ruptures passées.

> Un stock nul ou négatif constitue un signal de rupture théorique. Il doit être interprété en tenant compte de l’assortiment, du stock vendable et de la qualité des données.

### 2.2 Analyse des causes

Le système doit rapprocher les étapes de la chaîne logistique :

**Besoin → commande → préparation → expédition → réception → mise en rayon**

Causes possibles à analyser :

- Commande absente, tardive ou insuffisante du magasin.
- Indisponibilité du stock à l’entrepôt.
- Défaut de préparation ou quantité partiellement servie.
- Retard d’expédition ou de transport.
- Retard de réception ou de mise en rayon.
- Écart entre le stock informatique et le stock physique.
- Problème d’intégration entre les systèmes.
- Cause indéterminée faute de données suffisantes.

Chaque cause proposée doit être accompagnée, si possible, d’éléments justificatifs et d’un niveau de confiance : **confirmée, probable ou indéterminée**. Le système ne doit pas attribuer automatiquement une responsabilité sans preuves suffisantes.

### 2.3 Analyse par rayon

Le tableau de bord doit permettre de comparer les rayons selon :

- Le nombre d’articles en rupture.
- Le nombre d’épisodes de rupture.
- La durée moyenne et maximale des ruptures.
- Le taux de rupture parmi les articles actifs et attendus.
- Le chiffre d’affaires potentiellement perdu.
- La marge brute potentiellement perdue, si les données nécessaires sont disponibles.

### 2.4 Estimation des pertes

Les pertes doivent être présentées comme des **estimations**, et non comme des montants certains.

Formules de départ :

```text
Quantité potentiellement perdue =
max(0, ventes attendues pendant la rupture - ventes réalisées)

Chiffre d’affaires potentiel perdu =
quantité potentiellement perdue × prix de vente net attendu

Marge brute potentielle perdue =
quantité potentiellement perdue × marge brute unitaire attendue
```

La demande attendue peut être estimée à partir des mêmes jours de semaine sur les 6 à 8 dernières semaines comparables, en excluant les périodes de rupture et en traitant séparément les promotions ou les événements exceptionnels.

## 3. Sources de données

Les champs exacts et les modalités d’extraction restent à confirmer avec les équipes responsables de Cyrus et d’Asten.

| Source | Données recherchées | Utilisation |
|---|---|---|
| Référentiel commun | Code article, EAN, désignation, famille, rayon, magasin, entrepôt, assortiment | Faire correspondre les données |
| Asten — stocks | Stock magasin horodaté, stock bloqué ou invendable si disponible | Détecter et dater les ruptures |
| Asten — ventes | Quantités vendues, chiffre d’affaires, prix, retours, promotions | Estimer la demande et les pertes |
| Asten — commandes | Référence, quantités, dates de création et d’envoi, livraison attendue | Vérifier le réassort |
| Cyrus — stocks | Stock physique, réservé, bloqué et disponible à la préparation | Vérifier la disponibilité centrale |
| Cyrus — préparation/expédition | Quantités commandées, préparées et expédiées, dates et motifs de non-service | Identifier les problèmes d’entrepôt |
| Asten — réceptions | Références de commande et de bon de livraison, quantités reçues, dates et écarts | Comparer les quantités expédiées et reçues |
| Achats/approvisionnement | Commandes fournisseurs, dates attendues, quantités reçues et reliquats | Identifier les ruptures fournisseurs |
| Contrôle terrain | Disponibilité en rayon, stock en réserve, comptage physique, date du contrôle | Détecter les écarts physiques |

### Prérequis de données

- Disposer d’un historique horodaté des stocks.
- Avoir des identifiants communs ou des correspondances fiables entre articles, magasins, commandes et bons de livraison.
- Harmoniser les unités (unités, colis, etc.).
- Connaître les dates et heures de dernière actualisation des sources.
- Documenter les données manquantes et les cas impossibles à rapprocher.

Sans historique de stock ou clés de rapprochement fiables, l’analyse des causes restera partielle.

## 4. Indicateurs du tableau de bord

### Vue générale

- Nombre de ruptures en cours.
- Nombre d’articles concernés.
- Durée moyenne des ruptures.
- Taux de rupture.
- Chiffre d’affaires potentiellement perdu.
- Marge brute potentiellement perdue.
- Répartition des causes de rupture.

### Vue par magasin

- Articles actuellement en rupture.
- Rayon et famille de produits.
- Date et heure de début.
- Durée actuelle ou durée totale.
- Cause proposée et niveau de confiance.
- Commande en cours et livraison prévue, si disponibles.
- Action recommandée ou équipe à solliciter.

### Vue entrepôt / logistique

- Commandes non servies ou partiellement servies.
- Disponibilité du stock à la date de préparation.
- Taux de service en quantité.
- Retards de préparation, d’expédition et de livraison.

### Vue diagnostic

- Chronologie de l’épisode de rupture.
- Commandes et bons de livraison associés.
- Quantités commandées, préparées, expédiées et reçues.
- Cause retenue et justificatifs.
- Qualité et fraîcheur des données.

## 5. Règles métier initiales

| Situation | Cause proposée |
|---|---|
| Article actif avec stock magasin nul ou négatif | Rupture théorique à analyser |
| Commande absente, tardive ou insuffisante | Magasin / réassort |
| Commande passée à temps, stock central indisponible | Amont / entrepôt, ou fournisseur à préciser |
| Stock central disponible, mais quantité non préparée | Entrepôt |
| Expédition effectuée, livraison en retard | Transport / logistique |
| Marchandise reçue, mais rayon vide | Magasin, à confirmer sur le terrain |
| Stock informatique positif, mais rayon et réserve vides | Écart de stock / contrôle nécessaire |
| Commande envoyée mais absente du système destinataire | Interface informatique |
| Preuves ou horodatages insuffisants | Cause indéterminée |

Ces règles constituent une première version et devront être validées avec les équipes métier.

## 6. Architecture technique envisagée

Architecture indicative, à confirmer selon les accès disponibles :

```text
Cyrus ─────┐
           ├──> Extraction des données ──> Traitements Python / SQL
Asten ─────┘                                  │
                                             v
                                  Base de reporting
                              (PostgreSQL ou SQL Server)
                                             │
                                             v
                                   Power BI ou PROBI
```

- **Extraction :** API, exports CSV/Excel ou accès autorisés aux bases, selon les possibilités des systèmes.
- **Traitement :** nettoyage, harmonisation, rapprochement et calcul des indicateurs.
- **Stockage :** base de reporting avec historique et épisodes de rupture.
- **Restitution :** tableau de bord interactif et liste opérationnelle des ruptures.
- **Fréquence initiale :** actualisation quotidienne, à adapter selon les interfaces disponibles.

Cette architecture est une proposition ; elle ne signifie pas que les accès techniques à Cyrus ou Asten sont déjà disponibles.

## 7. Modèle de données cible

Une ligne de la table principale doit représenter un **épisode de rupture pour un article dans un magasin**.

Champs recommandés :

- Identifiant de l’épisode.
- Code article, EAN et désignation.
- Magasin et rayon.
- Date/heure de début et de fin.
- Durée de la rupture.
- Statut : en cours ou résolue.
- Stock constaté et date de dernière actualisation.
- Cause principale et cause détaillée.
- Origine proposée : magasin, entrepôt, transport, fournisseur, interface ou indéterminée.
- Niveau de confiance et justificatifs.
- Références de commande et de bon de livraison.
- Quantité potentiellement perdue.
- Chiffre d’affaires et marge potentiellement perdus.
- Date de dernière mise à jour.

## 8. Démarche de mise en œuvre

1. **Valider les données disponibles :** demander un échantillon d’extraction Cyrus et Asten sur un même article, magasin et flux de commande.
2. **Vérifier les correspondances :** articles, magasins, unités, commandes et bons de livraison.
3. **Créer l’historique :** enregistrer régulièrement les stocks et événements logistiques.
4. **Détecter les épisodes :** déterminer le début, la fin et la durée des ruptures.
5. **Développer les règles de diagnostic :** proposer une cause avec ses justificatifs et son niveau de confiance.
6. **Calculer les pertes estimées :** utiliser les ventes historiques et les prix/marges disponibles.
7. **Construire les vues :** direction, magasin, rayon, entrepôt et diagnostic.
8. **Tester un pilote :** commencer avec trois magasins représentatifs, un entrepôt et 200 à 500 articles à forte rotation.
9. **Faire valider les résultats :** comparer les causes proposées aux vérifications des équipes terrain.
10. **Ajuster et généraliser :** améliorer les règles avant un déploiement plus large.

## 9. Limites et points à valider

- Les noms exacts des champs et les accès à Cyrus et Asten restent à confirmer.
- La précision de la durée dépend de la fréquence des relevés de stock.
- La cause d’une rupture ne peut pas toujours être déterminée automatiquement.
- Les ventes perdues sont estimées et peuvent être surestimées en présence de produits de substitution.
- Le taux de rupture doit être calculé uniquement sur les articles actifs et attendus dans le magasin.
- Les seuils d’alerte et les règles de priorité doivent être validés avec les équipes métier.

## 10. Résultat attendu

Le projet doit fournir un tableau de bord permettant de :

- Repérer rapidement les ruptures actuelles et historiques.
- Mesurer leur durée.
- Identifier les causes probables et les étapes logistiques concernées.
- Comparer les ruptures par magasin et par rayon.
- Estimer les pertes potentielles de chiffre d’affaires et de marge.
- Prioriser les actions correctives à partir de données vérifiables.

---

**Statut du projet :** cadrage fonctionnel initial. Les sources de données, les accès, les règles métier et l’architecture finale doivent être confirmés avant le développement.
"""

path = Path("/mnt/data/README.md")
path.write_text(readme, encoding="utf-8")
print(f"Fichier créé : {path} ({path.stat().st_size} octets)")
