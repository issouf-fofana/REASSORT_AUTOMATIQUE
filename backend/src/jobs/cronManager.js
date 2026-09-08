const cron = require('node-cron');
const systemConfig = require('../services/systemConfigService');
const { runNightlyProposalGeneration } = require('./nightlyProposalJob');
const { runReceptionSync } = require('./receptionSyncJob');
const { runSalesSync } = require('./salesSyncJob');
const { runShopsSync } = require('./shopsSyncJob');
const { runDailyReplenishmentReview } = require('./dailyReplenishmentReviewJob');
const { createJobLock } = require('../utils/concurrency');
const { trackJobRun } = require('../services/jobHealthService');

let currentTask = null;
let currentReceptionSyncTask = null;
let currentSalesSyncTask = null;
let currentShopsSyncTask = null;
let currentDailyReviewTask = null;

// Un verrou par job : si une exécution précédente dépasse son intervalle planifié (cycle chargé
// sur beaucoup de magasins), le déclenchement suivant est ignoré plutôt que de tourner en même
// temps sur les mêmes serveurs RPOS partagés (audit performance : aucune protection existait).
const nightlyLock = createJobLock('Génération nocturne des propositions');
const receptionSyncLock = createJobLock('Synchronisation des réceptions');
const salesSyncLock = createJobLock('Synchronisation des ventes');
const shopsSyncLock = createJobLock('Synchronisation des magasins');
const dailyReviewLock = createJobLock('Réajustement quotidien du réassort');

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

module.exports = {
  startOrRestartNightlyJob,
  startOrRestartReceptionSyncJob,
  startOrRestartSalesSyncJob,
  startOrRestartShopsSyncJob,
  startOrRestartDailyReviewJob,
};
