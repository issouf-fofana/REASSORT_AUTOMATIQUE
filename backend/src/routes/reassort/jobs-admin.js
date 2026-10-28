// Sous-routeur 'jobs-admin' — Interface d'administration centralisée des jobs planifiés (vue
// d'ensemble, détail + historique paginé par job, logs d'une exécution précise, déclenchement
// manuel générique pour n'importe lequel des 26 jobs du registre). Monté dans
// routes/reassort/index.js sous le prefixe /api/reassort (requireAuth + requireSupervisedShop
// appliqués là-bas, pas ici). Créé le 26/10/2026 — distinct de jobs.js (anciennes routes de
// déclenchement manuel ad hoc, conservées pour compatibilité) et de config.js (ancienne route
// /system-config/jobs-health, dont la logique est désormais ici).
const express = require('express');
const cron = require('node-cron');
const router = express.Router();
const { requireAdmin } = require('../../middleware/auth');
const { listJobsOverview, getJobDetail, getRunDetail } = require('../../services/jobsAdminService');
const { trackJobRun } = require('../../services/jobHealthService');
const { getJobMeta, getRestartFnName } = require('../../jobs/jobRegistry');
const systemConfig = require('../../services/systemConfigService');
const prisma = require('../../utils/prisma');

// Les fonctions d'exécution elles-mêmes (une par job, cf. src/jobs/*.js) ne sont require() qu'au
// moment du déclenchement manuel (lazy, ci-dessous dans RUNNERS) pour ne pas alourdir le chargement
// de ce routeur avec les 26 modules de jobs à chaque démarrage du serveur.
const RUNNERS = {
  nightlyProposal: () => require('../../jobs/nightlyProposalJob').runNightlyProposalGeneration,
  receptionSync: () => require('../../jobs/receptionSyncJob').runReceptionSync,
  salesSync: () => require('../../jobs/salesSyncJob').runSalesSync,
  salesDailyRecap: () => require('../../jobs/salesDailyRecapJob').runSalesDailyRecap,
  productEolSync: () => require('../../jobs/productEndOfLifeSyncJob').runProductEndOfLifeSync,
  stockMoveSync: () => require('../../jobs/stockMoveSyncJob').runStockMoveSync,
  stockSnapshot: () => require('../../jobs/stockSnapshotJob').runStockSnapshotJob,
  stockoutLossRecalc: () => require('../../jobs/stockoutLossRecalcJob').runStockoutLossRecalcJob,
  stockoutDailyLossSnapshot: () => require('../../jobs/stockoutDailyLossSnapshotJob').runStockoutDailyLossSnapshotJob,
  supplierOrdersSync: () => require('../../jobs/supplierOrdersSyncJob').runSupplierOrdersSyncJob,
  stockoutSectorBackfill: () => require('../../jobs/stockoutSectorBackfillJob').runStockoutSectorBackfillJob,
  stockoutCatchUpResolve: () => require('../../jobs/stockoutCatchUpResolveJob').runStockoutCatchUpResolveJob,
  stockoutProductCacheRefresh: () => require('../../jobs/stockoutProductCacheRefreshJob').runStockoutProductCacheRefreshJob,
  overstockProductCacheRefresh: () => require('../../jobs/overstockProductCacheRefreshJob').runOverstockProductCacheRefreshJob,
  stockoutStatusRecalc: () => require('../../jobs/stockoutStatusRecalcJob').runStockoutStatusRecalcJob,
  stockoutAlert: () => require('../../jobs/stockoutAlertJob').runStockoutAlertJob,
  stockoutPeriodSummarySnapshot: () => require('../../jobs/stockoutPeriodSummarySnapshotJob').runStockoutPeriodSummarySnapshotJob,
  overstockReportSnapshot: () => require('../../jobs/overstockReportSnapshotJob').runOverstockReportSnapshotJob,
  orderIdentitySync: () => require('../../jobs/orderIdentitySyncJob').runOrderIdentitySync,
  shopsSync: () => require('../../jobs/shopsSyncJob').runShopsSync,
  dailyReplenishmentReview: () => require('../../jobs/dailyReplenishmentReviewJob').runDailyReplenishmentReview,
  predictionOutcome: () => require('../../jobs/predictionOutcomeJob').runPredictionOutcomeEvaluation,
  improvementWatchdog: () => require('../../jobs/improvementWatchdogJob').runImprovementWatchdog,
  proposalReminder: () => require('../../jobs/proposalReminderJob').runProposalReminder,
  endOfDayValidationRecap: () => require('../../jobs/endOfDayValidationRecapJob').runEndOfDayValidationRecap,
  tokenUsageWatchdog: () => require('../../jobs/tokenUsageWatchdogJob').runTokenUsageWatchdog,
};

// GET /api/reassort/jobs-admin - vue d'ensemble de tous les jobs planifiés (statut, dernière/
// prochaine exécution, fréquence) pour le tableau de bord de supervision.
router.get('/jobs-admin', requireAdmin, async (req, res) => {
  try {
    const data = await listJobsOverview();
    res.json({ success: true, data });
  } catch (error) {
    console.error('List jobs overview error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/jobs-admin/:jobName - détail d'un job + historique paginé des exécutions.
router.get('/jobs-admin/:jobName', requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const detail = await getJobDetail(req.params.jobName, { page, pageSize });
    if (!detail) return res.status(404).json({ success: false, message: 'Job inconnu' });
    res.json({ success: true, data: detail });
  } catch (error) {
    console.error('Get job detail error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/jobs-admin/runs/:runId - une exécution précise avec ses logs complets (pour le
// suivi en temps réel : le frontend poll cette route pendant qu'une exécution est 'running').
router.get('/jobs-admin/runs/:runId', requireAdmin, async (req, res) => {
  try {
    const run = await getRunDetail(req.params.runId);
    if (!run) return res.status(404).json({ success: false, message: 'Exécution introuvable' });
    res.json({ success: true, data: run });
  } catch (error) {
    console.error('Get job run detail error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/jobs-admin/:jobName/run - déclenche manuellement n'importe lequel des 26 jobs
// du registre, avec suivi complet (passe par trackJobRun comme le cron, triggeredBy: 'manual') —
// contrairement aux routes ad hoc de jobs.js qui n'enregistraient pas l'exécution déclenchée
// manuellement. Répond immédiatement avec le runId pour permettre au frontend de suivre la
// progression en direct sans bloquer la requête HTTP le temps du job complet.
router.post('/jobs-admin/:jobName/run', requireAdmin, async (req, res) => {
  const { jobName } = req.params;
  const meta = getJobMeta(jobName);
  const getRunner = RUNNERS[jobName];
  if (!meta || !getRunner) {
    return res.status(404).json({ success: false, message: 'Job inconnu' });
  }

  const runner = getRunner();
  const { runId, logger } = await require('../../services/jobHealthService').startJobRun(jobName, 'manual');
  res.json({ success: true, data: { runId } });

  // Exécution en tâche de fond après la réponse HTTP — le client suit la progression via
  // GET /jobs-admin/runs/:runId plutôt que d'attendre la fin du job sur la requête POST.
  (async () => {
    try {
      await runner(logger);
      await require('../../services/jobHealthService').finishJobRun(runId, 'success');
    } catch (err) {
      console.error(`Manual run error (${jobName}):`, err);
      await require('../../services/jobHealthService').finishJobRun(runId, 'error', err.message);
    }
  })();
});

// PUT /api/reassort/jobs-admin/:jobName/schedule - modifie la fréquence cron et/ou l'activation
// d'un job directement depuis la page Supervision (26/10/2026, demande explicite : "est-ce que je
// peux modifier la tâche planifier aussi ? je dois avoir la possibilité de faire tout ça") — même
// validation (cron.validate) et même mécanisme (écriture SystemConfig + startOrRestartXxxJob
// immédiat) que l'ancienne route générique PUT /system-config, mais couvre les 26 jobs du registre
// via jobRegistry.js au lieu d'une liste CRON_KEYS/ENABLED_KEYS figée à 6-8 jobs.
router.put('/jobs-admin/:jobName/schedule', requireAdmin, async (req, res) => {
  const { jobName } = req.params;
  const meta = getJobMeta(jobName);
  if (!meta) return res.status(404).json({ success: false, message: 'Job inconnu' });

  const { cronExpression, enabled } = req.body;
  try {
    if (cronExpression !== undefined) {
      if (!cron.validate(cronExpression)) {
        return res.status(400).json({ success: false, message: 'Expression cron invalide' });
      }
      await systemConfig.setValue(meta.cronKey, cronExpression);
    }
    if (enabled !== undefined) {
      await systemConfig.setValue(meta.enabledKey, enabled ? 'true' : 'false');
    }

    // Reprogramme immédiatement ce job avec la nouvelle config, sans attendre un redémarrage du
    // serveur — même principe que PUT /system-config pour les quelques jobs qu'il couvrait déjà.
    const cronManager = require('../../jobs/cronManager');
    const restartFn = cronManager[getRestartFnName(jobName)];
    if (typeof restartFn === 'function') await restartFn();

    const [newCron, newEnabled] = await Promise.all([
      systemConfig.getValue(meta.cronKey),
      systemConfig.getValue(meta.enabledKey),
    ]);
    res.json({ success: true, data: { cronExpression: newCron, enabled: newEnabled !== 'false' } });
  } catch (error) {
    console.error(`Update schedule error (${jobName}):`, error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/jobs-admin/runs/:runId/cancel - marque une exécution 'running' comme annulée
// (26/10/2026, demande explicite : "est-ce que je peux mettre en cours une tache et arrêté aussi ?")
// — AUCUN des 26 jobs ne vérifie un signal d'arrêt pendant son exécution (ils tournent jusqu'à leur
// fin naturelle), donc ceci ne coupe jamais le traitement RPOS déjà en cours côté serveur : ça
// nettoie seulement l'affichage d'une exécution qu'on sait bloquée/inutile à suivre plus longtemps,
// pour ne pas la laisser "En cours" indéfiniment dans l'historique. Documenté explicitement dans la
// réponse pour que le frontend puisse prévenir l'utilisateur de cette limite.
router.post('/jobs-admin/runs/:runId/cancel', requireAdmin, async (req, res) => {
  try {
    const run = await prisma.jobRun.findUnique({ where: { id: req.params.runId } });
    if (!run) return res.status(404).json({ success: false, message: 'Exécution introuvable' });
    if (run.status !== 'running') {
      return res.status(409).json({ success: false, message: 'Cette exécution est déjà terminée.' });
    }
    await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: 'error', finishedAt: new Date(), errorMessage: 'Annulée manuellement — le traitement déjà lancé côté serveur peut continuer jusqu\'à sa fin naturelle.' },
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Cancel job run error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
