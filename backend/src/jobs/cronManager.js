const cron = require('node-cron');
const systemConfig = require('../services/systemConfigService');
const { runNightlyProposalGeneration } = require('./nightlyProposalJob');
const { runReceptionSync } = require('./receptionSyncJob');
const { runSalesSync } = require('./salesSyncJob');
const { runSalesDailyRecap } = require('./salesDailyRecapJob');
const { runProductEndOfLifeSync } = require('./productEndOfLifeSyncJob');
const { runShopsSync } = require('./shopsSyncJob');
const { runDailyReplenishmentReview } = require('./dailyReplenishmentReviewJob');
const { runPredictionOutcomeEvaluation } = require('./predictionOutcomeJob');
const { runImprovementWatchdog } = require('./improvementWatchdogJob');
const { runProposalReminder } = require('./proposalReminderJob');
const { createJobLock } = require('../utils/concurrency');
const { trackJobRun } = require('../services/jobHealthService');

let currentTask = null;
let currentReceptionSyncTask = null;
let currentSalesSyncTask = null;
let currentSalesDailyRecapTask = null;
let currentProductEolSyncTask = null;
let currentShopsSyncTask = null;
let currentDailyReviewTask = null;
let currentPredictionOutcomeTask = null;
let currentImprovementWatchdogTask = null;
let currentProposalReminderTask = null;

// Un verrou par job : si une exécution précédente dépasse son intervalle planifié (cycle chargé
// sur beaucoup de magasins), le déclenchement suivant est ignoré plutôt que de tourner en même
// temps sur les mêmes serveurs RPOS partagés (audit performance : aucune protection existait).
const nightlyLock = createJobLock('Génération nocturne des propositions');
const receptionSyncLock = createJobLock('Synchronisation des réceptions');
const salesSyncLock = createJobLock('Synchronisation des ventes');
const salesDailyRecapLock = createJobLock('Récap quotidien de couverture des ventes');
const productEolSyncLock = createJobLock('Synchronisation des DLV actives');
const shopsSyncLock = createJobLock('Synchronisation des magasins');
const dailyReviewLock = createJobLock('Réajustement quotidien du réassort');
const predictionOutcomeLock = createJobLock('Évaluation des prédictions');
const improvementWatchdogLock = createJobLock('Chien de garde améliorations IA');
const proposalReminderLock = createJobLock('Relance des propositions en attente');

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

module.exports = {
  startOrRestartNightlyJob,
  startOrRestartReceptionSyncJob,
  startOrRestartSalesSyncJob,
  startOrRestartSalesDailyRecapJob,
  startOrRestartProductEolSyncJob,
  startOrRestartShopsSyncJob,
  startOrRestartDailyReviewJob,
  startOrRestartPredictionOutcomeJob,
  startOrRestartImprovementWatchdogJob,
  startOrRestartProposalReminderJob,
};
