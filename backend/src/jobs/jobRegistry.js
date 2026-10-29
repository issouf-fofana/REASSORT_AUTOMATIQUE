// Registre centralisé des 26 jobs planifiés par cronManager.js — source unique associant
// l'identifiant technique utilisé par trackJobRun()/JobRun.jobName à son libellé lisible et aux clés
// SystemConfig qui pilotent sa fréquence (xxx_CRON) et son activation (xxx_ENABLED). Créé le
// 26/10/2026 pour l'interface d'administration des jobs ("une interface d'administration
// centralisée... Avant de développer, analyse l'architecture existante... afin de ne laisser aucun
// cron ou job de côté") — évite de dupliquer cette correspondance dans chaque route/composant, et
// garantit qu'un job ajouté plus tard à cronManager.js n'est oublié qu'à un seul endroit si on omet
// de l'ajouter ici.
const systemConfig = require('../services/systemConfigService');

// `description` ajoutée le 29/10/2026 (demande explicite : "ajoute a coté de chaque tache planifier
// ce quil fait... si un user viens il pourra comprendre chaque tache") — une phrase courte, en
// langage utilisateur (jamais les noms techniques de table/colonne), affichée dans le tableau de
// bord des tâches planifiées à côté de chaque job.
const JOB_REGISTRY = [
  { jobName: 'nightlyProposal', label: 'Génération nocturne des propositions', description: 'Calcule chaque nuit les quantités à commander pour tous les magasins et prépare les propositions du lendemain.', cronKey: systemConfig.KEYS.NIGHTLY_PROPOSAL_CRON, enabledKey: systemConfig.KEYS.NIGHTLY_PROPOSAL_ENABLED },
  { jobName: 'receptionSync', label: 'Synchronisation des réceptions', description: 'Interroge RPOS pour savoir quelles commandes ont été reçues, validées ou annulées, et met à jour leur statut.', cronKey: systemConfig.KEYS.RECEPTION_SYNC_CRON, enabledKey: systemConfig.KEYS.RECEPTION_SYNC_ENABLED },
  { jobName: 'salesSync', label: 'Synchronisation des ventes', description: 'Récupère les ventes récentes depuis RPOS pour que les calculs de réassort utilisent des chiffres à jour.', cronKey: systemConfig.KEYS.SALES_SYNC_CRON, enabledKey: systemConfig.KEYS.SALES_SYNC_ENABLED },
  { jobName: 'salesDailyRecap', label: 'Récap quotidien de couverture des ventes', description: 'Vérifie une fois par jour que les ventes de tous les magasins ont bien été synchronisées, sans trou.', cronKey: systemConfig.KEYS.SALES_DAILY_RECAP_CRON, enabledKey: systemConfig.KEYS.SALES_DAILY_RECAP_ENABLED },
  { jobName: 'productEolSync', label: 'Synchronisation des DLV actives', description: "Met à jour la liste des articles ayant une date limite de vente (DLV) approchante, pour les signaler avant qu'ils ne périment.", cronKey: systemConfig.KEYS.PRODUCT_EOL_SYNC_CRON, enabledKey: systemConfig.KEYS.PRODUCT_EOL_SYNC_ENABLED },
  { jobName: 'stockMoveSync', label: 'Synchronisation des mouvements de stock', description: "Récupère depuis RPOS tous les mouvements de stock récents (arrivages, sorties, ajustements) pour suivre ce qui se passe réellement en magasin.", cronKey: systemConfig.KEYS.STOCK_MOVE_SYNC_CRON, enabledKey: systemConfig.KEYS.STOCK_MOVE_SYNC_ENABLED },
  { jobName: 'stockSnapshot', label: 'Capture des snapshots de stock (ruptures)', description: "Prend une photo régulière du stock de chaque article pour détecter automatiquement les nouvelles ruptures.", cronKey: systemConfig.KEYS.STOCK_SNAPSHOT_CRON, enabledKey: systemConfig.KEYS.STOCK_SNAPSHOT_ENABLED },
  { jobName: 'stockoutLossRecalc', label: 'Recalcul de la perte des ruptures en cours', description: "Recalcule le chiffre d'affaires perdu estimé pour chaque rupture de stock toujours en cours.", cronKey: systemConfig.KEYS.STOCKOUT_LOSS_RECALC_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_LOSS_RECALC_ENABLED },
  { jobName: 'stockoutDailyLossSnapshot', label: 'Précalcul journalier du CA perdu par rayon', description: "Enregistre chaque jour le CA perdu par rayon à cause des ruptures, pour alimenter les graphiques d'historique.", cronKey: systemConfig.KEYS.STOCKOUT_DAILY_LOSS_SNAPSHOT_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_DAILY_LOSS_SNAPSHOT_ENABLED },
  { jobName: 'supplierOrdersSync', label: 'Synchronisation du cache des commandes fournisseur RPOS', description: "Garde en cache les commandes fournisseur récentes de RPOS, pour détecter rapidement si une commande a été supprimée côté RPOS.", cronKey: systemConfig.KEYS.SUPPLIER_ORDERS_SYNC_CRON, enabledKey: systemConfig.KEYS.SUPPLIER_ORDERS_SYNC_ENABLED },
  { jobName: 'stockoutSectorBackfill', label: 'Résolution du secteur/rayon des ruptures en cours', description: "Retrouve le secteur et le rayon des articles en rupture qui n'en avaient pas encore, pour qu'ils apparaissent bien classés dans le module Ruptures.", cronKey: systemConfig.KEYS.STOCKOUT_SECTOR_BACKFILL_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_SECTOR_BACKFILL_ENABLED },
  { jobName: 'stockoutCatchUpResolve', label: 'Rattrapage de résolution des ruptures (arrivage déjà en base)', description: "Repasse sur les ruptures déjà reçues en stock mais pas encore marquées comme résolues, pour rattraper les cas manqués.", cronKey: systemConfig.KEYS.STOCKOUT_CATCH_UP_RESOLVE_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_CATCH_UP_RESOLVE_ENABLED },
  { jobName: 'stockoutProductCacheRefresh', label: 'Resynchronisation du stock RPOS des ruptures en cours', description: "Revérifie directement auprès de RPOS le stock réel des articles en rupture, pour confirmer qu'ils le sont toujours.", cronKey: systemConfig.KEYS.STOCKOUT_PRODUCT_CACHE_REFRESH_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_PRODUCT_CACHE_REFRESH_ENABLED },
  { jobName: 'overstockProductCacheRefresh', label: 'Resynchronisation du stock RPOS des articles en surstock', description: "Revérifie directement auprès de RPOS le stock réel des articles en surstock, pour confirmer qu'ils le sont toujours.", cronKey: systemConfig.KEYS.OVERSTOCK_PRODUCT_CACHE_REFRESH_CRON, enabledKey: systemConfig.KEYS.OVERSTOCK_PRODUCT_CACHE_REFRESH_ENABLED },
  { jobName: 'stockoutStatusRecalc', label: 'Précalcul du statut des ruptures en cours', description: "Recalcule pour chaque rupture en cours si elle a une commande, si elle est livrée, et son fournisseur (LC/LD) — affiché ensuite dans le module Ruptures.", cronKey: systemConfig.KEYS.STOCKOUT_STATUS_RECALC_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_STATUS_RECALC_ENABLED },
  { jobName: 'stockoutAlert', label: 'Alerte email des ruptures en cours', description: "Envoie un email récapitulatif des ruptures de stock en cours aux destinataires configurés.", cronKey: systemConfig.KEYS.STOCKOUT_ALERT_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_ALERT_ENABLED },
  { jobName: 'stockoutPeriodSummarySnapshot', label: "Précalcul de l'analyse des pertes par période (ruptures)", description: "Précalcule les statistiques de pertes sur une période donnée, pour que la page d'analyse se charge instantanément.", cronKey: systemConfig.KEYS.STOCKOUT_PERIOD_SUMMARY_SNAPSHOT_CRON, enabledKey: systemConfig.KEYS.STOCKOUT_PERIOD_SUMMARY_SNAPSHOT_ENABLED },
  { jobName: 'overstockReportSnapshot', label: 'Précalcul du rapport Surstock', description: "Précalcule la liste des articles en surstock pour que la page Surstock se charge rapidement.", cronKey: systemConfig.KEYS.OVERSTOCK_REPORT_SNAPSHOT_CRON, enabledKey: systemConfig.KEYS.OVERSTOCK_REPORT_SNAPSHOT_ENABLED },
  { jobName: 'orderIdentitySync', label: 'Synchronisation identité RPOS des commandes', description: "Vérifie qui a réellement créé/validé chaque commande côté RPOS, pour que l'historique affiche le bon auteur.", cronKey: systemConfig.KEYS.ORDER_IDENTITY_SYNC_CRON, enabledKey: systemConfig.KEYS.ORDER_IDENTITY_SYNC_ENABLED },
  { jobName: 'shopsSync', label: 'Synchronisation des magasins', description: "Met à jour la liste des magasins (ouverture, fermeture, informations) depuis RPOS.", cronKey: systemConfig.KEYS.SHOPS_SYNC_CRON, enabledKey: systemConfig.KEYS.SHOPS_SYNC_ENABLED },
  { jobName: 'dailyReplenishmentReview', label: 'Réajustement quotidien du réassort', description: "Analyse chaque jour la qualité des propositions passées pour ajuster automatiquement les règles de calcul du réassort.", cronKey: systemConfig.KEYS.DAILY_REVIEW_CRON, enabledKey: systemConfig.KEYS.DAILY_REVIEW_ENABLED },
  { jobName: 'predictionOutcome', label: 'Évaluation des prédictions', description: "Compare les prédictions de l'IA à ce qui s'est réellement passé, pour suivre sa fiabilité dans le temps.", cronKey: systemConfig.KEYS.PREDICTION_OUTCOME_CRON, enabledKey: systemConfig.KEYS.PREDICTION_OUTCOME_ENABLED },
  { jobName: 'improvementWatchdog', label: "Chien de garde améliorations IA", description: "Surveille que les améliorations automatiques proposées par l'IA restent cohérentes, et alerte en cas d'anomalie.", cronKey: systemConfig.KEYS.IMPROVEMENTS_CRON, enabledKey: systemConfig.KEYS.IMPROVEMENTS_ENABLED },
  { jobName: 'proposalReminder', label: 'Relance des propositions en attente', description: "Envoie un rappel pour les propositions de commande générées mais pas encore traitées par le magasin.", cronKey: systemConfig.KEYS.PROPOSAL_REMINDER_CRON, enabledKey: systemConfig.KEYS.PROPOSAL_REMINDER_ENABLED },
  { jobName: 'endOfDayValidationRecap', label: 'Récap de fin de journée', description: "Envoie en fin de journée un résumé des propositions validées et non validées par magasin.", cronKey: systemConfig.KEYS.END_OF_DAY_VALIDATION_RECAP_CRON, enabledKey: systemConfig.KEYS.END_OF_DAY_VALIDATION_RECAP_ENABLED },
  { jobName: 'tokenUsageWatchdog', label: 'Chien de garde consommation de tokens', description: "Surveille la consommation de tokens IA pour alerter avant d'atteindre un quota ou un coût anormal.", cronKey: systemConfig.KEYS.TOKEN_USAGE_ALERT_CRON, enabledKey: systemConfig.KEYS.TOKEN_USAGE_ALERT_ENABLED },
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
