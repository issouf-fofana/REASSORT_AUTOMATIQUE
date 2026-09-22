// Sous-routeur 'jobs' — Declenchement manuel des jobs planifies (ADMIN, diagnostic via Paramètres ou tests).
// Monte dans routes/reassort/index.js sous le prefixe /api/reassort (requireAuth +
// requireSupervisedShop appliques la-bas, pas ici). Ne jamais monter ailleurs.
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../../middleware/auth');
const { runNightlyProposalGeneration } = require('../../jobs/nightlyProposalJob');
const { runReceptionSync } = require('../../jobs/receptionSyncJob');
const { runSalesSync } = require('../../jobs/salesSyncJob');
const { runSalesDailyRecap } = require('../../jobs/salesDailyRecapJob');
const { runProductEndOfLifeSync } = require('../../jobs/productEndOfLifeSyncJob');

router.post('/run-nightly-job', requireAdmin, async (req, res) => {
  try {
    await runNightlyProposalGeneration();
    res.json({ success: true, message: 'Job de génération nocturne exécuté' });
  } catch (error) {
    console.error('Manual nightly job error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/run-reception-sync - déclenche manuellement la synchronisation des statuts
// de réception RPOS (ADMIN, pour les tests)
router.post('/run-reception-sync', requireAdmin, async (req, res) => {
  try {
    await runReceptionSync();
    res.json({ success: true, message: 'Synchronisation des statuts de réception exécutée' });
  } catch (error) {
    console.error('Manual reception sync error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/run-sales-sync - déclenche manuellement la synchronisation incrémentale des
// ventes de tous les magasins actifs (ADMIN, pour les tests — s'exécute normalement toutes les
// 15 minutes automatiquement).
router.post('/run-sales-sync', requireAdmin, async (req, res) => {
  try {
    await runSalesSync();
    res.json({ success: true, message: 'Synchronisation des ventes exécutée' });
  } catch (error) {
    console.error('Manual sales sync error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/run-sales-daily-recap - déclenche manuellement le récap quotidien de
// couverture des ventes (ADMIN, pour les tests — s'exécute normalement chaque jour à 23:59
// automatiquement). Vérifie RPOS vs local jour par jour pour la journée qui vient de se terminer,
// sur chaque magasin actif, et relance une récupération ciblée en cas d'écart.
router.post('/run-sales-daily-recap', requireAdmin, async (req, res) => {
  try {
    await runSalesDailyRecap();
    res.json({ success: true, message: 'Récap quotidien de couverture des ventes exécuté' });
  } catch (error) {
    console.error('Manual sales daily recap error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/run-product-eol-sync - déclenche manuellement la synchronisation des DLV
// actives (ADMIN, pour les tests — s'exécute normalement toutes les heures automatiquement).
router.post('/run-product-eol-sync', requireAdmin, async (req, res) => {
  try {
    await runProductEndOfLifeSync();
    res.json({ success: true, message: 'Synchronisation des DLV exécutée' });
  } catch (error) {
    console.error('Manual product EOL sync error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/run-daily-review - déclenche manuellement le réajustement quotidien des
// plans hebdomadaires (ADMIN, pour les tests). CAHIER_DES_CHARGES.md §15-16, étape 3.
router.post('/run-daily-review', requireAdmin, async (req, res) => {
  try {
    const { runDailyReplenishmentReview } = require('../../jobs/dailyReplenishmentReviewJob');
    const result = await runDailyReplenishmentReview();
    res.json({ success: true, message: 'Réajustement quotidien exécuté', data: result });
  } catch (error) {
    console.error('Manual daily review error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/run-prediction-outcome - déclenche manuellement l'évaluation des prédictions
// dont la période cible est terminée (ADMIN, pour les tests). CAHIER_DES_CHARGES.md §22, étape 5.
router.post('/run-prediction-outcome', requireAdmin, async (req, res) => {
  try {
    const { runPredictionOutcomeEvaluation } = require('../../jobs/predictionOutcomeJob');
    const result = await runPredictionOutcomeEvaluation();
    res.json({ success: true, message: 'Évaluation des prédictions exécutée', data: result });
  } catch (error) {
    console.error('Manual prediction outcome error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/sales-backfill - démarre (ou reprend, si un run existe déjà pour ce magasin
// et cette période exacte) une récupération historique volumineuse de l'historique de vente d'un
// magasin, découpée en tranches persistées avec reprise automatique (ADMIN). Ne bloque pas : le
// travail continue en tâche de fond, répond immédiatement avec le runId pour permettre le suivi
// (GET /sales-backfill/:runId/status). Body: { posId, shopId, days } OU { posId, shopId,
// periodStart, periodEnd } pour choisir un intervalle de dates précis plutôt qu'un simple nombre
// de jours glissants depuis aujourd'hui.
module.exports = router;
