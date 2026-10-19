const cron = require('node-cron');
const systemConfig = require('../services/systemConfigService');
const { runNightlyProposalGeneration } = require('./nightlyProposalJob');
const { runReceptionSync } = require('./receptionSyncJob');
const { runSalesSync } = require('./salesSyncJob');
const { runSalesDailyRecap } = require('./salesDailyRecapJob');
const { runProductEndOfLifeSync } = require('./productEndOfLifeSyncJob');
const { runStockMoveSync } = require('./stockMoveSyncJob');
const { runStockSnapshotJob } = require('./stockSnapshotJob');
const { runStockoutLossRecalcJob } = require('./stockoutLossRecalcJob');
const { runStockoutSectorBackfillJob } = require('./stockoutSectorBackfillJob');
const { runStockoutCatchUpResolveJob } = require('./stockoutCatchUpResolveJob');
const { runStockoutAlertJob } = require('./stockoutAlertJob');
const { runStockoutPeriodSummarySnapshotJob } = require('./stockoutPeriodSummarySnapshotJob');
const { runOrderIdentitySync } = require('./orderIdentitySyncJob');
const { runShopsSync } = require('./shopsSyncJob');
const { runDailyReplenishmentReview } = require('./dailyReplenishmentReviewJob');
const { runPredictionOutcomeEvaluation } = require('./predictionOutcomeJob');
const { runImprovementWatchdog } = require('./improvementWatchdogJob');
const { runProposalReminder } = require('./proposalReminderJob');
const { runEndOfDayValidationRecap } = require('./endOfDayValidationRecapJob');
const { runTokenUsageWatchdog } = require('./tokenUsageWatchdogJob');
const { createJobLock } = require('../utils/concurrency');
const { trackJobRun } = require('../services/jobHealthService');

let currentTask = null;
let currentReceptionSyncTask = null;
let currentSalesSyncTask = null;
let currentSalesDailyRecapTask = null;
let currentProductEolSyncTask = null;
let currentStockMoveSyncTask = null;
let currentStockSnapshotTask = null;
let currentStockoutLossRecalcTask = null;
let currentStockoutSectorBackfillTask = null;
let currentStockoutCatchUpResolveTask = null;
let currentStockoutAlertTask = null;
let currentStockoutPeriodSummarySnapshotTask = null;
let currentOrderIdentitySyncTask = null;
let currentShopsSyncTask = null;
let currentDailyReviewTask = null;
let currentPredictionOutcomeTask = null;
let currentImprovementWatchdogTask = null;
let currentProposalReminderTask = null;
let currentEndOfDayValidationRecapTask = null;
let currentTokenUsageWatchdogTask = null;

// Un verrou par job : si une exécution précédente dépasse son intervalle planifié (cycle chargé
// sur beaucoup de magasins), le déclenchement suivant est ignoré plutôt que de tourner en même
// temps sur les mêmes serveurs RPOS partagés (audit performance : aucune protection existait).
const nightlyLock = createJobLock('Génération nocturne des propositions');
const receptionSyncLock = createJobLock('Synchronisation des réceptions');
const salesSyncLock = createJobLock('Synchronisation des ventes');
const salesDailyRecapLock = createJobLock('Récap quotidien de couverture des ventes');
const productEolSyncLock = createJobLock('Synchronisation des DLV actives');
const stockMoveSyncLock = createJobLock('Synchronisation des mouvements de stock');
const stockSnapshotLock = createJobLock('Capture des snapshots de stock (ruptures)');
const stockoutLossRecalcLock = createJobLock('Recalcul de la perte des ruptures en cours');
const stockoutSectorBackfillLock = createJobLock('Résolution du secteur/rayon des ruptures en cours');
const stockoutCatchUpResolveLock = createJobLock('Rattrapage de résolution des ruptures (arrivage déjà en base)');
const stockoutAlertLock = createJobLock('Alerte email des ruptures en cours');
const stockoutPeriodSummarySnapshotLock = createJobLock('Précalcul de l\'analyse des pertes par période (ruptures)');
const orderIdentitySyncLock = createJobLock('Synchronisation identité RPOS des commandes');
const shopsSyncLock = createJobLock('Synchronisation des magasins');
const dailyReviewLock = createJobLock('Réajustement quotidien du réassort');
const predictionOutcomeLock = createJobLock('Évaluation des prédictions');
const improvementWatchdogLock = createJobLock('Chien de garde améliorations IA');
const proposalReminderLock = createJobLock('Relance des propositions en attente');
const endOfDayValidationRecapLock = createJobLock('Récap de fin de journée');
const tokenUsageWatchdogLock = createJobLock('Chien de garde consommation de tokens');

/** true si la valeur stockée pour cette clé d'activation vaut "true" (chaîne, cf. systemConfig). */
async function isJobEnabled(enabledKey) {
  const value = await systemConfig.getValue(enabledKey);
  return value !== 'false'; // activé par défaut si jamais réglé (cohérent avec ENV_FALLBACK = 'true')
}

/** (Re)programme le job nocturne selon l'horaire actuellement en base (ou par défaut). */
async function startOrRestartNightlyJob() {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.NIGHTLY_PROPOSAL_ENABLED))) {
    console.log('⏸️  Job nocturne désactivé (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.NIGHTLY_PROPOSAL_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), job nocturne non planifié`);
    return;
  }

  currentTask = cron.schedule(cronSchedule, () => {
    nightlyLock(async () => {
      console.log('[cron] Démarrage de la génération nocturne des propositions...');
      await trackJobRun('nightlyProposal', runNightlyProposalGeneration);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Job nocturne planifié: ${cronSchedule}`);
}

/** (Re)programme le job de synchronisation des statuts de réception RPOS. */
async function startOrRestartReceptionSyncJob() {
  if (currentReceptionSyncTask) {
    currentReceptionSyncTask.stop();
    currentReceptionSyncTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.RECEPTION_SYNC_ENABLED))) {
    console.log('⏸️  Synchronisation des réceptions désactivée (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.RECEPTION_SYNC_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), synchronisation des réceptions non planifiée`);
    return;
  }

  currentReceptionSyncTask = cron.schedule(cronSchedule, () => {
    receptionSyncLock(async () => {
      console.log('[cron] Démarrage de la synchronisation des statuts de réception...');
      await trackJobRun('receptionSync', runReceptionSync);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Synchronisation des réceptions planifiée: ${cronSchedule}`);
}

/** (Re)programme le job de synchronisation locale des ventes RPOS. */
async function startOrRestartSalesSyncJob() {
  if (currentSalesSyncTask) {
    currentSalesSyncTask.stop();
    currentSalesSyncTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.SALES_SYNC_ENABLED))) {
    console.log('⏸️  Synchronisation des ventes désactivée (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.SALES_SYNC_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), synchronisation des ventes non planifiée`);
    return;
  }

  currentSalesSyncTask = cron.schedule(cronSchedule, () => {
    salesSyncLock(async () => {
      console.log('[cron] Démarrage de la synchronisation des ventes...');
      await trackJobRun('salesSync', runSalesSync);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Synchronisation des ventes planifiée: ${cronSchedule}`);
}

/** (Re)programme le récap quotidien de couverture des ventes (vérification jour-par-jour RPOS vs
 * local pour la journée qui vient de se terminer, sur chaque magasin — cf. salesDailyRecapJob.js). */
async function startOrRestartSalesDailyRecapJob() {
  if (currentSalesDailyRecapTask) {
    currentSalesDailyRecapTask.stop();
    currentSalesDailyRecapTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.SALES_DAILY_RECAP_ENABLED))) {
    console.log('⏸️  Récap quotidien de couverture des ventes désactivé (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.SALES_DAILY_RECAP_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), récap quotidien de couverture des ventes non planifié`);
    return;
  }

  currentSalesDailyRecapTask = cron.schedule(cronSchedule, () => {
    salesDailyRecapLock(async () => {
      console.log('[cron] Démarrage du récap quotidien de couverture des ventes...');
      await trackJobRun('salesDailyRecap', runSalesDailyRecap);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Récap quotidien de couverture des ventes planifié: ${cronSchedule}`);
}

/** (Re)programme la synchronisation locale des DLV actives (end_of_life_product), demande du
 * 22/09/2026 — cf. productEndOfLifeSyncJob.js pour le détail. */
async function startOrRestartProductEolSyncJob() {
  if (currentProductEolSyncTask) {
    currentProductEolSyncTask.stop();
    currentProductEolSyncTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.PRODUCT_EOL_SYNC_ENABLED))) {
    console.log('⏸️  Synchronisation des DLV désactivée (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.PRODUCT_EOL_SYNC_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), synchronisation des DLV non planifiée`);
    return;
  }

  currentProductEolSyncTask = cron.schedule(cronSchedule, () => {
    productEolSyncLock(async () => {
      console.log('[cron] Démarrage de la synchronisation des DLV...');
      await trackJobRun('productEolSync', runProductEndOfLifeSync);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Synchronisation des DLV planifiée: ${cronSchedule}`);
}

/** (Re)programme la synchronisation locale des mouvements de stock (stockMoveSyncJob.js). */
async function startOrRestartStockMoveSyncJob() {
  if (currentStockMoveSyncTask) {
    currentStockMoveSyncTask.stop();
    currentStockMoveSyncTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.STOCK_MOVE_SYNC_ENABLED))) {
    console.log('⏸️  Synchronisation des mouvements de stock désactivée (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.STOCK_MOVE_SYNC_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), synchronisation des mouvements de stock non planifiée`);
    return;
  }

  currentStockMoveSyncTask = cron.schedule(cronSchedule, () => {
    stockMoveSyncLock(async () => {
      console.log('[cron] Démarrage de la synchronisation des mouvements de stock...');
      await trackJobRun('stockMoveSync', runStockMoveSync);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Synchronisation des mouvements de stock planifiée: ${cronSchedule}`);
}

/** (Re)programme la capture périodique du stock pour la détection des épisodes de rupture (stockSnapshotJob.js). */
async function startOrRestartStockSnapshotJob() {
  if (currentStockSnapshotTask) {
    currentStockSnapshotTask.stop();
    currentStockSnapshotTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.STOCK_SNAPSHOT_ENABLED))) {
    console.log('⏸️  Capture des snapshots de stock désactivée (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.STOCK_SNAPSHOT_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), capture des snapshots de stock non planifiée`);
    return;
  }

  currentStockSnapshotTask = cron.schedule(cronSchedule, () => {
    stockSnapshotLock(async () => {
      console.log('[cron] Démarrage de la capture des snapshots de stock...');
      await trackJobRun('stockSnapshot', runStockSnapshotJob);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Capture des snapshots de stock planifiée: ${cronSchedule}`);
}

/** (Re)programme le recalcul périodique de la perte des épisodes de rupture EN_COURS (stockoutLossRecalcJob.js). */
async function startOrRestartStockoutLossRecalcJob() {
  if (currentStockoutLossRecalcTask) {
    currentStockoutLossRecalcTask.stop();
    currentStockoutLossRecalcTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.STOCKOUT_LOSS_RECALC_ENABLED))) {
    console.log('⏸️  Recalcul de la perte des ruptures désactivé (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.STOCKOUT_LOSS_RECALC_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), recalcul de la perte des ruptures non planifié`);
    return;
  }

  currentStockoutLossRecalcTask = cron.schedule(cronSchedule, () => {
    stockoutLossRecalcLock(async () => {
      console.log('[cron] Démarrage du recalcul de la perte des ruptures en cours...');
      await trackJobRun('stockoutLossRecalc', runStockoutLossRecalcJob);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Recalcul de la perte des ruptures planifié: ${cronSchedule}`);
}

/** (Re)programme la résolution périodique du secteur/rayon des épisodes EN_COURS encore à null (stockoutSectorBackfillJob.js). */
async function startOrRestartStockoutSectorBackfillJob() {
  if (currentStockoutSectorBackfillTask) {
    currentStockoutSectorBackfillTask.stop();
    currentStockoutSectorBackfillTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.STOCKOUT_SECTOR_BACKFILL_ENABLED))) {
    console.log('⏸️  Résolution du secteur/rayon des ruptures désactivée (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.STOCKOUT_SECTOR_BACKFILL_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), résolution du secteur/rayon des ruptures non planifiée`);
    return;
  }

  currentStockoutSectorBackfillTask = cron.schedule(cronSchedule, () => {
    stockoutSectorBackfillLock(async () => {
      console.log('[cron] Démarrage de la résolution du secteur/rayon des ruptures en cours...');
      await trackJobRun('stockoutSectorBackfill', runStockoutSectorBackfillJob);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Résolution du secteur/rayon des ruptures planifiée: ${cronSchedule}`);
}

/** (Re)programme le filet de rattrapage des ruptures résolvables par un arrivage déjà en base (stockoutCatchUpResolveJob.js). */
async function startOrRestartStockoutCatchUpResolveJob() {
  if (currentStockoutCatchUpResolveTask) {
    currentStockoutCatchUpResolveTask.stop();
    currentStockoutCatchUpResolveTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.STOCKOUT_CATCH_UP_RESOLVE_ENABLED))) {
    console.log('⏸️  Rattrapage de résolution des ruptures désactivé (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.STOCKOUT_CATCH_UP_RESOLVE_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), rattrapage de résolution des ruptures non planifié`);
    return;
  }

  currentStockoutCatchUpResolveTask = cron.schedule(cronSchedule, () => {
    stockoutCatchUpResolveLock(async () => {
      console.log('[cron] Démarrage du rattrapage de résolution des ruptures...');
      await trackJobRun('stockoutCatchUpResolve', runStockoutCatchUpResolveJob);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Rattrapage de résolution des ruptures planifié: ${cronSchedule}`);
}

/** (Re)programme le précalcul nocturne de "Analyse des pertes sur une période" (stockoutPeriodSummarySnapshotJob.js). */
async function startOrRestartStockoutPeriodSummarySnapshotJob() {
  if (currentStockoutPeriodSummarySnapshotTask) {
    currentStockoutPeriodSummarySnapshotTask.stop();
    currentStockoutPeriodSummarySnapshotTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.STOCKOUT_PERIOD_SUMMARY_SNAPSHOT_ENABLED))) {
    console.log('⏸️  Précalcul de l\'analyse des pertes par période désactivé (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.STOCKOUT_PERIOD_SUMMARY_SNAPSHOT_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), précalcul de l'analyse des pertes par période non planifié`);
    return;
  }

  currentStockoutPeriodSummarySnapshotTask = cron.schedule(cronSchedule, () => {
    stockoutPeriodSummarySnapshotLock(async () => {
      console.log('[cron] Démarrage du précalcul de l\'analyse des pertes par période...');
      await trackJobRun('stockoutPeriodSummarySnapshot', runStockoutPeriodSummarySnapshotJob);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Précalcul de l'analyse des pertes par période planifié: ${cronSchedule}`);
}

/** (Re)programme l'alerte email récapitulative des ruptures EN_COURS par magasin (stockoutAlertJob.js). */
async function startOrRestartStockoutAlertJob() {
  if (currentStockoutAlertTask) {
    currentStockoutAlertTask.stop();
    currentStockoutAlertTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.STOCKOUT_ALERT_ENABLED))) {
    console.log('⏸️  Alerte email des ruptures désactivée (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.STOCKOUT_ALERT_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), alerte email des ruptures non planifiée`);
    return;
  }

  currentStockoutAlertTask = cron.schedule(cronSchedule, () => {
    stockoutAlertLock(async () => {
      console.log('[cron] Démarrage de l\'alerte email des ruptures en cours...');
      await trackJobRun('stockoutAlert', runStockoutAlertJob);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Alerte email des ruptures planifiée: ${cronSchedule}`);
}

/** (Re)programme la synchronisation de l'identité RPOS des commandes (qui a créé/validé, quand) —
 * orderIdentitySyncJob.js, précalcule ce que getEpisodeDetail affichait avant via un appel RPOS en
 * direct à chaque lecture (bug de performance corrigé le 18/10/2026). */
async function startOrRestartOrderIdentitySyncJob() {
  if (currentOrderIdentitySyncTask) {
    currentOrderIdentitySyncTask.stop();
    currentOrderIdentitySyncTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.ORDER_IDENTITY_SYNC_ENABLED))) {
    console.log('⏸️  Synchronisation identité RPOS des commandes désactivée (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.ORDER_IDENTITY_SYNC_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), synchronisation identité RPOS des commandes non planifiée`);
    return;
  }

  currentOrderIdentitySyncTask = cron.schedule(cronSchedule, () => {
    orderIdentitySyncLock(async () => {
      console.log('[cron] Démarrage de la synchronisation identité RPOS des commandes...');
      await trackJobRun('orderIdentitySync', runOrderIdentitySync);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Synchronisation identité RPOS des commandes planifiée: ${cronSchedule}`);
}

/** (Re)programme le job de synchronisation locale de la liste des magasins RPOS. */
async function startOrRestartShopsSyncJob() {
  if (currentShopsSyncTask) {
    currentShopsSyncTask.stop();
    currentShopsSyncTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.SHOPS_SYNC_ENABLED))) {
    console.log('⏸️  Synchronisation des magasins désactivée (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.SHOPS_SYNC_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), synchronisation des magasins non planifiée`);
    return;
  }

  currentShopsSyncTask = cron.schedule(cronSchedule, () => {
    shopsSyncLock(async () => {
      console.log('[cron] Démarrage de la synchronisation des magasins...');
      await trackJobRun('shopsSync', runShopsSync);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Synchronisation des magasins planifiée: ${cronSchedule}`);
}

/** (Re)programme le job de réajustement quotidien du réassort (CAHIER_DES_CHARGES.md §15-16). */
async function startOrRestartDailyReviewJob() {
  if (currentDailyReviewTask) {
    currentDailyReviewTask.stop();
    currentDailyReviewTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.DAILY_REVIEW_ENABLED))) {
    console.log('⏸️  Réajustement quotidien désactivé (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.DAILY_REVIEW_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), réajustement quotidien non planifié`);
    return;
  }

  currentDailyReviewTask = cron.schedule(cronSchedule, () => {
    dailyReviewLock(async () => {
      console.log('[cron] Démarrage du réajustement quotidien du réassort...');
      await trackJobRun('dailyReplenishmentReview', runDailyReplenishmentReview);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Réajustement quotidien du réassort planifié: ${cronSchedule}`);
}

/** (Re)programme le job d'évaluation des prédictions passées (CAHIER_DES_CHARGES.md §22, étape 5). */
async function startOrRestartPredictionOutcomeJob() {
  if (currentPredictionOutcomeTask) {
    currentPredictionOutcomeTask.stop();
    currentPredictionOutcomeTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.PREDICTION_OUTCOME_ENABLED))) {
    console.log('⏸️  Évaluation des prédictions désactivée (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.PREDICTION_OUTCOME_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), évaluation des prédictions non planifiée`);
    return;
  }

  currentPredictionOutcomeTask = cron.schedule(cronSchedule, () => {
    predictionOutcomeLock(async () => {
      console.log('[cron] Démarrage de l\'évaluation des prédictions...');
      await trackJobRun('predictionOutcome', runPredictionOutcomeEvaluation);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Évaluation des prédictions planifiée: ${cronSchedule}`);
}

/** (Re)programme le chien de garde du Conseiller d'amélioration IA (première brique AI Center). */
async function startOrRestartImprovementWatchdogJob() {
  if (currentImprovementWatchdogTask) {
    currentImprovementWatchdogTask.stop();
    currentImprovementWatchdogTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.IMPROVEMENTS_ENABLED))) {
    console.log('⏸️  Chien de garde améliorations IA désactivé (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.IMPROVEMENTS_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), chien de garde améliorations IA non planifié`);
    return;
  }

  currentImprovementWatchdogTask = cron.schedule(cronSchedule, () => {
    improvementWatchdogLock(async () => {
      console.log('[cron] Démarrage du chien de garde améliorations IA...');
      await trackJobRun('improvementWatchdog', runImprovementWatchdog);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Chien de garde améliorations IA planifié: ${cronSchedule}`);
}

/** (Re)programme la relance des propositions en attente (demande du 25/09/2026, 10h par défaut —
 * avant la limite de réception entrepôt à 13h). */
async function startOrRestartProposalReminderJob() {
  if (currentProposalReminderTask) {
    currentProposalReminderTask.stop();
    currentProposalReminderTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.PROPOSAL_REMINDER_ENABLED))) {
    console.log('⏸️  Relance des propositions en attente désactivée (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.PROPOSAL_REMINDER_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), relance des propositions non planifiée`);
    return;
  }

  currentProposalReminderTask = cron.schedule(cronSchedule, () => {
    proposalReminderLock(async () => {
      console.log('[cron] Démarrage de la relance des propositions en attente...');
      await trackJobRun('proposalReminder', runProposalReminder);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Relance des propositions en attente planifiée: ${cronSchedule}`);
}

/** (Re)programme le récap de fin de journée pour les ADMIN (demande du 26/09/2026, 16h30 par
 * défaut — juste après la fermeture de la fenêtre entrepôt à 13h). */
async function startOrRestartEndOfDayValidationRecapJob() {
  if (currentEndOfDayValidationRecapTask) {
    currentEndOfDayValidationRecapTask.stop();
    currentEndOfDayValidationRecapTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.END_OF_DAY_VALIDATION_RECAP_ENABLED))) {
    console.log('⏸️  Récap de fin de journée désactivé (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.END_OF_DAY_VALIDATION_RECAP_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), récap de fin de journée non planifié`);
    return;
  }

  currentEndOfDayValidationRecapTask = cron.schedule(cronSchedule, () => {
    endOfDayValidationRecapLock(async () => {
      console.log('[cron] Démarrage du récap de fin de journée...');
      await trackJobRun('endOfDayValidationRecap', runEndOfDayValidationRecap);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Récap de fin de journée planifié: ${cronSchedule}`);
}

/** (Re)programme le chien de garde de consommation de tokens IA (demande du 12/10/2026, suite à un
 * pic réel de 36,9M tokens en une journée découvert seulement après coup) — alerte les ADMIN par
 * email si le total des dernières 24h dépasse TOKEN_USAGE_ALERT_THRESHOLD_TOKENS. */
async function startOrRestartTokenUsageWatchdogJob() {
  if (currentTokenUsageWatchdogTask) {
    currentTokenUsageWatchdogTask.stop();
    currentTokenUsageWatchdogTask = null;
  }

  if (!(await isJobEnabled(systemConfig.KEYS.TOKEN_USAGE_ALERT_ENABLED))) {
    console.log('⏸️  Chien de garde consommation de tokens désactivé (voir Paramètres).');
    return;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.TOKEN_USAGE_ALERT_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), chien de garde consommation de tokens non planifié`);
    return;
  }

  currentTokenUsageWatchdogTask = cron.schedule(cronSchedule, () => {
    tokenUsageWatchdogLock(async () => {
      console.log('[cron] Vérification de la consommation de tokens IA...');
      await trackJobRun('tokenUsageWatchdog', runTokenUsageWatchdog);
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Chien de garde consommation de tokens planifié: ${cronSchedule}`);
}

module.exports = {
  startOrRestartNightlyJob,
  startOrRestartReceptionSyncJob,
  startOrRestartSalesSyncJob,
  startOrRestartSalesDailyRecapJob,
  startOrRestartProductEolSyncJob,
  startOrRestartStockMoveSyncJob,
  startOrRestartStockSnapshotJob,
  startOrRestartStockoutLossRecalcJob,
  startOrRestartStockoutSectorBackfillJob,
  startOrRestartStockoutCatchUpResolveJob,
  startOrRestartStockoutAlertJob,
  startOrRestartStockoutPeriodSummarySnapshotJob,
  startOrRestartOrderIdentitySyncJob,
  startOrRestartShopsSyncJob,
  startOrRestartDailyReviewJob,
  startOrRestartPredictionOutcomeJob,
  startOrRestartImprovementWatchdogJob,
  startOrRestartProposalReminderJob,
  startOrRestartEndOfDayValidationRecapJob,
  startOrRestartTokenUsageWatchdogJob,
};
