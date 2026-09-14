// Point d'entree du domaine /api/reassort — NE CONTIENT AUCUNE ROUTE.
//
// Decoupage P1 (dossier routes/reassort/) : l'ancien god file reassort.js
// (2228 lignes) est reparti en 8 sous-routeurs par domaine fonctionnel.
// Les URLs servies sont INCHANGEES (montage a chemin vide + requireAuth et
// requireSupervisedShop appliques ici, une seule fois pour tout le domaine).
//
//  jobs.js      (5 routes)  — declenchement manuel des jobs planifies (ADMIN)
//  backfill.js  (6 routes)  — recuperation d'historique par tranches
//  sales.js     (5 routes)  — lignes de vente locales + couverture
//  shops.js     (6 routes)  — magasins/serveurs RPOS, commandes fournisseurs
//  proposals.js (14 routes) — generation, validation, envoi des propositions
//  insights.js  (10 routes) — plans hebdo, predictions, statistiques
//  config.js    (8 routes)  — config magasin/systeme, fichiers, sante des jobs
//  ai.js        (25 routes) — cles IA, analyse article, chatbot, audit, improvements
//
// Regle : toute nouvelle route /api/reassort/* va dans le sous-routeur de son
// domaine, jamais ici.
const express = require('express');
const router = express.Router();
const { requireAuth, requireSupervisedShop } = require('../../middleware/auth');

router.use(requireAuth);
// Cloisonnement SUPERVISOR : verifie en base (jamais via le JWT) que le magasin cible par la
// requete fait bien partie de son perimetre supervise (readme §29-30). No-op pour ADMIN/STORE.
router.use(requireSupervisedShop);

router.use(require('./jobs'));
router.use(require('./backfill'));
router.use(require('./sales'));
router.use(require('./shops'));
router.use(require('./proposals'));
router.use(require('./insights'));
router.use(require('./config'));
router.use(require('./ai'));

module.exports = router;
