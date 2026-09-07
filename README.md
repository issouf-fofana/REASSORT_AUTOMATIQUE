# 📦 Stock Auto-Réappro

Plateforme intelligente de gestion des stocks et de réassort automatique.

## 🚀 Fonctionnalités

- ✅ Gestion des produits (SKU, catégories, prix, seuils)
- ✅ Suivi du stock en temps réel
- ✅ Alertes de stock basse
- ✅ Moteur de réassort automatique
- ✅ Gestion des fournisseurs
- ✅ Commandes automatiques
- ✅ Tableau de bord avec KPIs
- ✅ Traçabilité des mouvements de stock

## 🛠️ Stack Technique

- **Backend**: Node.js + Express
- **Base de données**: PostgreSQL
- **ORM**: Prisma
- **Frontend**: HTML5 + Bootstrap 5
- **Déploiement**: Docker + Dokploy

## 📦 Installation

### Prérequis

- Node.js >= 18
- PostgreSQL
- Docker (optionnel)

### Setup local

```bash
# Cloner le projet
git clone <repository-url>
cd stock-auto-reappro

# Installer les dépendances
npm install

# Configurer l'environnement
cp .env.example .env
# Éditer .env avec vos paramètres

# Générer le client Prisma
npm run db:generate

# Créer les tables
npm run db:push

# Peupler la base avec des données de test
npm run db:seed

# Démarrer le serveur
npm run dev
```

L'application sera accessible sur `http://localhost:3000`

### Avec Docker

```bash
# Démarrer avec Docker Compose
docker-compose up -d

# ou pour Dokploy, utiliser dokploy.yaml
docker compose -f dokploy.yaml up -d
```

## 🗄️ Base de données

### Schéma principal

- **products**: Produits avec seuils et stock
- **categories**: Catégories de produits
- **suppliers**: Fournisseurs
- **orders**: Commandes fournisseurs
- **order_items**: Éléments de commande
- **stock_movements**: Historique des mouvements
- **users**: Utilisateurs

### Formule de réassort

```
Quantité à commander = Stock cible - Stock actuel - Commandes en cours
```

Où:
- Stock cible = max(Stock maximum, Stock minimum × 2)
- Arrondi au multiple de la quantité par carton

## 🐳 Déploiement Dokploy

1. Créer un nouveau projet dans Dokploy
2. Sélectionner "Docker Compose"
3. Importer le fichier `dokploy.yaml`
4. Configurer les variables d'environnement:
   - `POSTGRES_PASSWORD`: Mot de passe PostgreSQL
   - `JWT_SECRET`: Secret pour les tokens JWT
   - `CORS_ORIGIN`: URL du frontend (ou `*`)
5. Déployer

## 📡 API Endpoints

### Produits
- `GET /api/products` - Liste des produits
- `GET /api/products/:id` - Détail d'un produit
- `POST /api/products` - Créer un produit
- `PUT /api/products/:id` - Modifier un produit
- `DELETE /api/products/:id` - Supprimer un produit

### Stock
- `GET /api/stock/movements` - Mouvements de stock
- `POST /api/stock/movement` - Enregistrer un mouvement
- `GET /api/stock/alerts` - Alertes de stock
- `GET /api/stock/restock-recommendations` - Recommandations

### Commandes
- `GET /api/orders` - Liste des commandes
- `POST /api/orders` - Créer une commande
- `POST /api/orders/auto-generate` - Générer commandes auto
- `PUT /api/orders/:id/status` - Changer statut

### Dashboard
- `GET /api/dashboard/stats` - Statistiques
- `GET /api/dashboard/alerts` - Alertes
- `GET /api/dashboard/chart` - Données graphiques

## 📝 Licence

MIT
