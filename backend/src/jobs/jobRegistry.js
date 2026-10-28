// Registre centralisé des 26 jobs planifiés par cronManager.js — source unique associant
// l'identifiant technique utilisé par trackJobRun()/JobRun.jobName à son libellé lisible et aux clés
// SystemConfig qui pilotent sa fréquence (xxx_CRON) et son activation (xxx_ENABLED). Créé le
// 26/10/2026 pour l'interface d'administration des jobs ("une interface d'administration
// centralisée... Avant de développer, analyse l'architecture existante... afin de ne laisser aucun
// cron ou job de côté") — évite de dupliquer cette correspondance dans chaque route/composant, et
// garantit qu'un job ajouté plus tard à cronManager.js n'est oublié qu'à un seul endroit si on omet
// de l'ajouter ici.
const systemConfig = require('../services/systemConfigService');

const JOB_REGISTRY = [
  { jobName: 'nightlyProposal', label: 'Génération nocturne des propositions', cronKey: systemConfig.KEYS.NIGHTLY_PROPOSAL_CRON, enabledKey: systemConfig.KEYS.NIGHTLY_PROPOSAL_ENABLED },
  { jobName: 'receptionSync', label: 'Synchronisation des réceptions', cronKey: systemConfig.KEYS.RECEPTION_SYNC_CRON, enabledKey: systemConfig.KEYS.RECEPTION_SYNC_ENABLED },
  { jobName: 'salesSync', label: 'Synchronisation des ventes', cronKey: systemConfig.KEYS.SALES_SYNC_CRON, enabledKey: systemConfig.KEYS.SALES_SYNC_ENABLED },
  { jobName: 'salesDailyRecap', label: 'Récap quotidien de couverture des ventes', cronKey: systemConfig.KEYS.SALES_DAILY_RECAP_CRON, enabledKey: systemConfig.KEYS.SALES_DAILY_RECAP_ENABLED },
  { jobName: 'productEolSync', label: 'Synchronisation des DLV actives', cronKey: systemConfig.KEYS.PRODUCT_EOL_SYNC_CRON, enabledKey: systemConfig.KEYS.PRODUCT_EOL_SYNC_ENABLED },
  { jobName: 'stockMoveSync', label: 'Synchronisation des mouvements de stock', cronKey: systemConfig.KEYS.STOCK_MOVE_SYNC_CRON, enabledKey: systemConfig.KEYS.STOCK_MOVE_SYNC_ENABLED },
  { jobName: 'stockSnapshot', label: 'Capture des snapshots de stock (ruptures)', cronKey: systemConfig.KEYS.STOCK_SNAPSHOT_CRON, enabledKey: systemConfig.KEYS.STOCK_SNAPSHOT_ENABLED },
  { jobName: 'stockoutLossRecalc', label: 'Recalcul de la perte des ruptures en cours', cronKey: systemConfig.KEYS.STOCKOUT_LOSS_RECALC_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_LOSS_RECALC_ENABLED },
  { jobName: 'stockoutDailyLossSnapshot', label: 'Précalcul journalier du CA perdu par rayon', cronKey: systemConfig.KEYS.STOCKOUT_DAILY_LOSS_SNAPSHOT_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_DAILY_LOSS_SNAPSHOT_ENABLED },
  { jobName: 'supplierOrdersSync', label: 'Synchronisation du cache des commandes fournisseur RPOS', cronKey: systemConfig.KEYS.SUPPLIER_ORDERS_SYNC_CRON, enabledKey: systemConfig.KEYS.SUPPLIER_ORDERS_SYNC_ENABLED },
  { jobName: 'stockoutSectorBackfill', label: 'Résolution du secteur/rayon des ruptures en cours', cronKey: systemConfig.KEYS.STOCKOUT_SECTOR_BACKFILL_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_SECTOR_BACKFILL_ENABLED },
  { jobName: 'stockoutCatchUpResolve', label: 'Rattrapage de résolution des ruptures (arrivage déjà en base)', cronKey: systemConfig.KEYS.STOCKOUT_CATCH_UP_RESOLVE_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_CATCH_UP_RESOLVE_ENABLED },
  { jobName: 'stockoutProductCacheRefresh', label: 'Resynchronisation du stock RPOS des ruptures en cours', cronKey: systemConfig.KEYS.STOCKOUT_PRODUCT_CACHE_REFRESH_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_PRODUCT_CACHE_REFRESH_ENABLED },
  { jobName: 'overstockProductCacheRefresh', label: 'Resynchronisation du stock RPOS des articles en surstock', cronKey: systemConfig.KEYS.OVERSTOCK_PRODUCT_CACHE_REFRESH_CRON, enabledKey: systemConfig.KEYS.OVERSTOCK_PRODUCT_CACHE_REFRESH_ENABLED },
  { jobName: 'stockoutStatusRecalc', label: 'Précalcul du statut des ruptures en cours', cronKey: systemConfig.KEYS.STOCKOUT_STATUS_RECALC_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_STATUS_RECALC_ENABLED },
  { jobName: 'stockoutAlert', label: 'Alerte email des ruptures en cours', cronKey: systemConfig.KEYS.STOCKOUT_ALERT_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_ALERT_ENABLED },
  { jobName: 'stockoutPeriodSummarySnapshot', label: "Précalcul de l'analyse des pertes par période (ruptures)", cronKey: systemConfig.KEYS.STOCKOUT_PERIOD_SUMMARY_SNAPSHOT_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_PERIOD_SUMMARY_SNAPSHOT_ENABLED },
  { jobName: 'overstockReportSnapshot', label: 'Précalcul du rapport Surstock', cronKey: systemConfig.KEYS.OVERSTOCK_REPORT_SNAPSHOT_CRON, enabledKey: systemConfig.KEYS.OVERSTOCK_REPORT_SNAPSHOT_ENABLED },
  { jobName: 'orderIdentitySync', label: 'Synchronisation identité RPOS des commandes', cronKey: systemConfig.KEYS.ORDER_IDENTITY_SYNC_CRON, enabledKey: systemConfig.KEYS.ORDER_IDENTITY_SYNC_ENABLED },
  { jobName: 'shopsSync', label: 'Synchronisation des magasins', cronKey: systemConfig.KEYS.SHOPS_SYNC_CRON, enabledKey: systemConfig.KEYS.SHOPS_SYNC_ENABLED },
  { jobName: 'dailyReplenishmentReview', label: 'Réajustement quotidien du réassort', cronKey: systemConfig.KEYS.DAILY_REVIEW_CRON, enabledKey: systemConfig.KEYS.DAILY_REVIEW_ENABLED },
  { jobName: 'predictionOutcome', label: 'Évaluation des prédictions', cronKey: systemConfig.KEYS.PREDICTION_OUTCOME_CRON, enabledKey: systemConfig.KEYS.PREDICTION_OUTCOME_ENABLED },
  { jobName: 'improvementWatchdog', label: "Chien de garde améliorations IA", cronKey: systemConfig.KEYS.IMPROVEMENTS_CRON, enabledKey: systemConfig.KEYS.IMPROVEMENTS_ENABLED },
  { jobName: 'proposalReminder', label: 'Relance des propositions en attente', cronKey: systemConfig.KEYS.PROPOSAL_REMINDER_CRON, enabledKey: systemConfig.KEYS.PROPOSAL_REMINDER_ENABLED },
  { jobName: 'endOfDayValidationRecap', label: 'Récap de fin de journée', cronKey: systemConfig.KEYS.END_OF_DAY_VALIDATION_RECAP_CRON, enabledKey: systemConfig.KEYS.END_OF_DAY_VALIDATION_RECAP_ENABLED },
  { jobName: 'tokenUsageWatchdog', label: 'Chien de garde consommation de tokens', cronKey: systemConfig.KEYS.TOKEN_USAGE_ALERT_CRON, enabledKey: systemConfig.KEYS.TOKEN_USAGE_ALERT_ENABLED },
];

function getJobMeta(jobName) {
  return JOB_REGISTRY.find((j) => j.jobName === jobName) || null;
}

// Nom de la fonction startOrRestartXxxJob (cronManager.js) à appeler après un changement de
// cron/activation pour reprogrammer immédiatement ce job — déduit par convention
// (startOrRestart + PascalCase(jobName) + Job), SAUF ces 2 exceptions historiques dont le nom ne
// suit pas exactement le jobName utilisé par trackJobRun (vérifié exhaustivement le 26/10/2026).
const RESTART_FN_OVERRIDES = {
  nightlyProposal: 'startOrRestartNightlyJob',
  dailyReplenishmentReview: 'startOrRestartDailyReviewJob',
};

function getRestartFnName(jobName) {
  if (RESTART_FN_OVERRIDES[jobName]) return RESTART_FN_OVERRIDES[jobName];
  return 'startOrRestart' + jobName[0].toUpperCase() + jobName.slice(1) + 'Job';
}

module.exports = { JOB_REGISTRY, getJobMeta, getRestartFnName };
