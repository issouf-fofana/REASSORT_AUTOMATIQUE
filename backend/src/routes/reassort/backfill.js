// Sous-routeur 'backfill' — Recuperation d'historique de ventes par tranches (pause/reprise/annulation).
// Monte dans routes/reassort/index.js sous le prefixe /api/reassort (requireAuth +
// requireSupervisedShop appliques la-bas, pas ici). Ne jamais monter ailleurs.
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin, resolveShopId, resolvePosId, requireSupervisedShop } = require('../../middleware/auth');
const salesBackfillService = require('../../services/salesBackfillService');

router.post('/sales-backfill', requireAdmin, async (req, res) => {
  try {
    const { posId, shopId, days, periodStart: bodyStart, periodEnd: bodyEnd } = req.body;
    if (!posId || !shopId) {
      return res.status(400).json({ success: false, message: 'posId et shopId requis' });
    }
    const now = new Date();
    const periodEnd = bodyEnd ? new Date(bodyEnd) : now;
    const periodStart = bodyStart ? new Date(bodyStart) : new Date(now.getTime() - (days || 90) * 24 * 60 * 60 * 1000);
    if (periodStart >= periodEnd) {
      return res.status(400).json({ success: false, message: 'La date de début doit être antérieure à la date de fin' });
    }
    const runId = await salesBackfillService.startBackfill(posId, shopId, periodStart.toISOString(), periodEnd.toISOString());
    res.json({ success: true, message: 'Récupération démarrée', data: { runId } });
  } catch (error) {
    console.error('Sales backfill error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/sales-backfill/:runId/status - progression détaillée d'un run (ADMIN), pour
// affichage en temps réel (polling côté UI) : total attendu/récupéré, % d'avancement, détail par
// tranche (terminée / en cours / en attente / erreur).
router.get('/sales-backfill/:runId/status', requireAdmin, async (req, res) => {
  try {
    const status = await salesBackfillService.getRunStatus(req.params.runId);
    if (!status) return res.status(404).json({ success: false, message: 'Run introuvable' });
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/sales-backfill/active?shopId=... - trouve un run interrompu ou en cours pour
// ce magasin (ADMIN), pour proposer une reprise dès l'ouverture de la page plutôt que de laisser
// l'utilisateur relancer manuellement et redécouvrir la persistance par hasard.
router.get('/sales-backfill/active', requireAdmin, async (req, res) => {
  try {
    const { shopId } = req.query;
    if (!shopId) return res.status(400).json({ success: false, message: 'shopId requis' });
    const run = await salesBackfillService.findResumableRun(shopId);
    res.json({ success: true, data: run });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/sales-backfill/:runId/resume - relance le traitement d'un run existant
// (ADMIN) : reprend les tranches non terminées là où elles se sont arrêtées, sans retélécharger
// les tranches déjà DONE ni dupliquer les lignes déjà insérées d'une tranche partiellement faite.
router.post('/sales-backfill/:runId/resume', requireAdmin, async (req, res) => {
  try {
    salesBackfillService.processRun(req.params.runId).catch((err) => console.error('Resume backfill error:', err.message));
    res.json({ success: true, message: 'Reprise démarrée' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/sales-backfill/:runId/pause - demande l'arrêt propre d'un run en cours
// (ADMIN) : la progression déjà persistée (pages et tranches terminées) est conservée, le run passe
// à PAUSED dès que le traitement en cours atteint son prochain point de contrôle (entre deux pages
// RPOS, quelques secondes), et peut être repris plus tard via /resume sans rien perdre.
router.post('/sales-backfill/:runId/pause', requireAdmin, async (req, res) => {
  try {
    await salesBackfillService.requestPause(req.params.runId);
    res.json({ success: true, message: 'Pause demandée, en cours d\'arrêt...' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/sales-backfill/:runId/cancel - annule définitivement un run bloqué
// (PAUSED ou ERROR, ex: coupure réseau pendant la récupération) : les lignes déjà récupérées
// restent en base, seul le run est clos pour ne plus être proposé en reprise. Un run IN_PROGRESS
// doit d'abord être mis en pause (/pause) avant de pouvoir être annulé.
router.post('/sales-backfill/:runId/cancel', requireAdmin, async (req, res) => {
  try {
    await salesBackfillService.cancelRun(req.params.runId);
    res.json({ success: true, message: 'Récupération annulée. Les ventes déjà récupérées restent disponibles.' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/sales-lines - consultation paginée des ventes synchronisées localement pour
// un magasin (ADMIN), avec filtres période/article, pour vérifier ce qui a réellement été récupéré
// sans repasser par RPOS. Query: shopId (requis), dateStart, dateEnd, ean, page, pageSize.
module.exports = router;
