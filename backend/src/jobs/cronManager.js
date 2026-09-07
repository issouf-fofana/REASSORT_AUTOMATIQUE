const cron = require('node-cron');
const systemConfig = require('../services/systemConfigService');
const { runNightlyProposalGeneration } = require('./nightlyProposalJob');
const { runReceptionSync } = require('./receptionSyncJob');
const { runSalesSync } = require('./salesSyncJob');
const { runShopsSync } = require('./shopsSyncJob');
const { createJobLock } = require('../utils/concurrency');

let currentTask = null;
let currentReceptionSyncTask = null;
let currentSalesSyncTask = null;
let currentShopsSyncTask = null;

// Un verrou par job : si une exécution précédente dépasse son intervalle planifié (cycle chargé
// sur beaucoup de magasins), le déclenchement suivant est ignoré plutôt que de tourner en même
// temps sur les mêmes serveurs RPOS partagés (audit performance : aucune protection existait).
const nightlyLock = createJobLock('Génération nocturne des propositions');
const receptionSyncLock = createJobLock('Synchronisation des réceptions');
const salesSyncLock = createJobLock('Synchronisation des ventes');
const shopsSyncLock = createJobLock('Synchronisation des magasins');

/** (Re)programme le job nocturne selon l'horaire actuellement en base (ou par défaut). */
async function startOrRestartNightlyJob() {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.NIGHTLY_PROPOSAL_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), job nocturne non planifié`);
    return;
  }

  currentTask = cron.schedule(cronSchedule, () => {
    nightlyLock(async () => {
      console.log('[cron] Démarrage de la génération nocturne des propositions...');
      await runNightlyProposalGeneration();
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

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.RECEPTION_SYNC_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), synchronisation des réceptions non planifiée`);
    return;
  }

  currentReceptionSyncTask = cron.schedule(cronSchedule, () => {
    receptionSyncLock(async () => {
      console.log('[cron] Démarrage de la synchronisation des statuts de réception...');
      await runReceptionSync();
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

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.SALES_SYNC_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), synchronisation des ventes non planifiée`);
    return;
  }

  currentSalesSyncTask = cron.schedule(cronSchedule, () => {
    salesSyncLock(async () => {
      console.log('[cron] Démarrage de la synchronisation des ventes...');
      await runSalesSync();
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

  const cronSchedule = await systemConfig.getValue(systemConfig.KEYS.SHOPS_SYNC_CRON);

  if (!cron.validate(cronSchedule)) {
    console.error(`[cronManager] Expression cron invalide ("${cronSchedule}"), synchronisation des magasins non planifiée`);
    return;
  }

  currentShopsSyncTask = cron.schedule(cronSchedule, () => {
    shopsSyncLock(async () => {
      console.log('[cron] Démarrage de la synchronisation des magasins...');
      await runShopsSync();
    }).catch((err) => console.error('[cron] Erreur:', err));
  });

  console.log(`⏰ Synchronisation des magasins planifiée: ${cronSchedule}`);
}

module.exports = { startOrRestartNightlyJob, startOrRestartReceptionSyncJob, startOrRestartSalesSyncJob, startOrRestartShopsSyncJob };
