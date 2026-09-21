// Sous-routeur 'config' — Configuration magasin et systeme, fichiers de ventes, sante des jobs.
// Monte dans routes/reassort/index.js sous le prefixe /api/reassort (requireAuth +
// requireSupervisedShop appliques la-bas, pas ici). Ne jamais monter ailleurs.
const express = require('express');
const router = express.Router();
const { requireAdmin, resolveShopId } = require('../../middleware/auth');
const rpos = require('../../services/rposClient');
const { getConfig, upsertConfig } = require('../../services/configService');
const { MODE_DAYS } = require('../../services/periodService');
const systemConfig = require('../../services/systemConfigService');
const { findSalesFiles, ensureManualImportDir, importCsvFileToDatabase, MANUAL_IMPORT_DIR } = require('../../services/salesFileService');
const jobHealthService = require('../../services/jobHealthService');
const { VALID_INTENT_TOOLS } = require('../../services/chatbotService');
const multer = require('multer');
const path = require('path');

// Nom de fichier strictement validé (même format que findSalesFiles) pour ne jamais écrire en
// dehors du dossier configuré ni accepter un fichier qui ne serait pas détecté ensuite. Déclaré ici
// (avant salesFileUpload) car réutilisé par le storage multer lui-même, pas seulement par la route.
const SALES_FILE_NAME_PATTERN = /^[a-zA-Z0-9]+_statvente-lignes_articles_[a-zA-Z0-9_-]+\.csv$/i;

// Stockage disque en flux direct (17/09/2026, remplace memoryStorage) : un export RPOS dépasse
// régulièrement 300 Mo selon la période couverte — charger un tel fichier ENTIÈREMENT en RAM avant
// de l'écrire (comportement de memoryStorage) devient risqué si plusieurs imports se chevauchent
// (mémoire du serveur épuisée). diskStorage laisse Node streamer directement le corps de la requête
// vers le fichier final, sans jamais retenir tout le contenu en mémoire à la fois. La validation du
// nom (SALES_FILE_NAME_PATTERN) doit se faire ICI, dans `filename`, appelée AVANT toute écriture —
// contrairement à l'ancien code qui validait après coup sur req.file.originalname (sans risque avec
// memoryStorage puisque rien n'était encore écrit, mais un nom invalide écrirait désormais un
// fichier partiel sur disque si la validation restait après l'upload).
//
// Écrit dans MANUAL_IMPORT_DIR (dossier local du serveur), PAS dans SALES_FILES_DIR (17/09/2026) :
// avant ce fix, un import manuel échouait dès que le dossier réseau partagé (généralement un montage
// /mnt/asten) était indisponible — précisément le scénario où cette solution de secours ("sans avoir
// besoin d'un accès manuel au partage réseau") est censée servir. readSalesLinesForPeriod
// (salesFileService.js) cherche désormais dans les deux dossiers, donc un fichier importé ici reste
// utilisable normalement pour la génération de propositions.
const salesFileUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        cb(null, ensureManualImportDir());
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      if (!SALES_FILE_NAME_PATTERN.test(file.originalname)) {
        return cb(new Error(`Nom de fichier invalide : "${file.originalname}". Format attendu : <code_magasin>_statvente-lignes_articles_<date>.csv (ex: 050_statvente-lignes_articles_01062024_0000.csv)`));
      }
      // path.basename() défend contre un nom contenant des séparateurs de chemin (../, /) malgré la
      // validation par regex ci-dessus — ceinture et bretelles sur un chemin d'écriture disque
      // construit à partir d'une entrée utilisateur.
      cb(null, path.basename(file.originalname));
    },
  }),
});

// Paramètres réassort réservés au Superadmin uniquement (décision explicite du 15/09/2026 :
// "personne ne doit voir les paramètres à part le superadmin") — Directeur/Chef de département/
// Rayonniste/Superviseur n'y ont plus accès du tout, alors qu'un compte STORE pouvait auparavant
// consulter/modifier les paramètres de son propre magasin. Changement de portée volontaire, pas un
// bug : ces rôles pilotent le réassort au quotidien (propositions, Assistant IA) mais ne touchent
// plus aux réglages qui influencent le calcul lui-même (seuils, période d'analyse...).
router.get('/config', requireAdmin, async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const config = await getConfig(shopId);
    res.json({ success: true, data: { ...config, availablePeriodModes: Object.keys(MODE_DAYS).concat('CUSTOM') } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/reassort/config - met à jour la configuration réassort du magasin
// body: { paretoThreshold, safetyStockRatio, periodMode, customStart, customEnd,
//         treatNegativeStockAsZero, revenueSharePeriodDays, overstockThresholdMultiplier, splitOrdersByDepartment, forecastAccuracyWindowDays, forecastAccuracyThresholdPct, seasonalityComparisonEnabled, seasonalityLookbackYears, seasonalityAdjustmentThresholdPct, receptionLeadTimeDays, useReceptionLeadTimeInCalculation, excludeGenericArticlesBelowPrice }
router.put('/config', requireAdmin, async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    const {
      paretoThreshold, safetyStockRatio, periodMode, customStart, customEnd,
      treatNegativeStockAsZero, revenueSharePeriodDays, overstockThresholdMultiplier, splitOrdersByDepartment, forecastAccuracyWindowDays, forecastAccuracyThresholdPct, seasonalityComparisonEnabled, seasonalityLookbackYears, seasonalityAdjustmentThresholdPct, receptionLeadTimeDays, useReceptionLeadTimeInCalculation, excludeGenericArticlesBelowPrice, recentOrderMaxAgeDays, forecastEnabled, forecastAlpha, ignoreRposStockInCalculation,
    } = req.body;
    const data = {};
    if (paretoThreshold !== undefined) data.paretoThreshold = paretoThreshold;
    if (safetyStockRatio !== undefined) data.safetyStockRatio = safetyStockRatio;
    if (periodMode !== undefined) data.periodMode = periodMode;
    if (customStart !== undefined) data.customStart = customStart ? new Date(customStart) : null;
    if (customEnd !== undefined) data.customEnd = customEnd ? new Date(customEnd) : null;
    if (treatNegativeStockAsZero !== undefined) data.treatNegativeStockAsZero = treatNegativeStockAsZero;
    if (revenueSharePeriodDays !== undefined) data.revenueSharePeriodDays = revenueSharePeriodDays;
    if (overstockThresholdMultiplier !== undefined) data.overstockThresholdMultiplier = overstockThresholdMultiplier;
    if (splitOrdersByDepartment !== undefined) data.splitOrdersByDepartment = splitOrdersByDepartment;
    if (forecastAccuracyWindowDays !== undefined) data.forecastAccuracyWindowDays = forecastAccuracyWindowDays;
    if (forecastAccuracyThresholdPct !== undefined) data.forecastAccuracyThresholdPct = forecastAccuracyThresholdPct;
    if (seasonalityComparisonEnabled !== undefined) data.seasonalityComparisonEnabled = seasonalityComparisonEnabled;
    if (seasonalityLookbackYears !== undefined) data.seasonalityLookbackYears = seasonalityLookbackYears;
    if (seasonalityAdjustmentThresholdPct !== undefined) data.seasonalityAdjustmentThresholdPct = seasonalityAdjustmentThresholdPct;
    if (receptionLeadTimeDays !== undefined) data.receptionLeadTimeDays = receptionLeadTimeDays;
    if (useReceptionLeadTimeInCalculation !== undefined) data.useReceptionLeadTimeInCalculation = useReceptionLeadTimeInCalculation;
    if (excludeGenericArticlesBelowPrice !== undefined) data.excludeGenericArticlesBelowPrice = excludeGenericArticlesBelowPrice;
    if (recentOrderMaxAgeDays !== undefined) data.recentOrderMaxAgeDays = recentOrderMaxAgeDays;
    if (forecastEnabled !== undefined) data.forecastEnabled = forecastEnabled;
    if (forecastAlpha !== undefined) data.forecastAlpha = forecastAlpha;
    if (ignoreRposStockInCalculation !== undefined) data.ignoreRposStockInCalculation = ignoreRposStockInCalculation;

    const config = await upsertConfig(shopId, data, req.user.email);
    res.json({ success: true, data: config });
  } catch (error) {
    console.error('Update config error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/reassort/config/bulk - applique les mêmes paramètres à plusieurs magasins (Superadmin
// uniquement — décision explicite du 15/09/2026 : "personne ne doit voir les paramètres à part le
// superadmin", y compris SUPERVISOR qui pouvait auparavant configurer les magasins de son
// périmètre). requireAdmin remplace l'ancien contrôle manuel par rôle, désormais inutile ici.
// body: { shopIds: [uuid, ...], paretoThreshold, safetyStockRatio, periodMode, customStart, customEnd,
//         treatNegativeStockAsZero, revenueSharePeriodDays, overstockThresholdMultiplier, splitOrdersByDepartment, forecastAccuracyWindowDays, forecastAccuracyThresholdPct, seasonalityComparisonEnabled, seasonalityLookbackYears, seasonalityAdjustmentThresholdPct, receptionLeadTimeDays, useReceptionLeadTimeInCalculation, excludeGenericArticlesBelowPrice }
router.put('/config/bulk', requireAdmin, async (req, res) => {
  try {
    const {
      shopIds, paretoThreshold, safetyStockRatio, periodMode, customStart, customEnd,
      treatNegativeStockAsZero, revenueSharePeriodDays, overstockThresholdMultiplier, splitOrdersByDepartment, forecastAccuracyWindowDays, forecastAccuracyThresholdPct, seasonalityComparisonEnabled, seasonalityLookbackYears, seasonalityAdjustmentThresholdPct, receptionLeadTimeDays, useReceptionLeadTimeInCalculation, excludeGenericArticlesBelowPrice, recentOrderMaxAgeDays, forecastEnabled, forecastAlpha, ignoreRposStockInCalculation,
    } = req.body;
    if (!Array.isArray(shopIds) || shopIds.length === 0) {
      return res.status(400).json({ success: false, message: 'shopIds (tableau non vide) est requis' });
    }

    const data = {};
    if (paretoThreshold !== undefined) data.paretoThreshold = paretoThreshold;
    if (safetyStockRatio !== undefined) data.safetyStockRatio = safetyStockRatio;
    if (periodMode !== undefined) data.periodMode = periodMode;
    if (customStart !== undefined) data.customStart = customStart ? new Date(customStart) : null;
    if (customEnd !== undefined) data.customEnd = customEnd ? new Date(customEnd) : null;
    if (treatNegativeStockAsZero !== undefined) data.treatNegativeStockAsZero = treatNegativeStockAsZero;
    if (revenueSharePeriodDays !== undefined) data.revenueSharePeriodDays = revenueSharePeriodDays;
    if (overstockThresholdMultiplier !== undefined) data.overstockThresholdMultiplier = overstockThresholdMultiplier;
    if (splitOrdersByDepartment !== undefined) data.splitOrdersByDepartment = splitOrdersByDepartment;
    if (forecastAccuracyWindowDays !== undefined) data.forecastAccuracyWindowDays = forecastAccuracyWindowDays;
    if (forecastAccuracyThresholdPct !== undefined) data.forecastAccuracyThresholdPct = forecastAccuracyThresholdPct;
    if (seasonalityComparisonEnabled !== undefined) data.seasonalityComparisonEnabled = seasonalityComparisonEnabled;
    if (seasonalityLookbackYears !== undefined) data.seasonalityLookbackYears = seasonalityLookbackYears;
    if (seasonalityAdjustmentThresholdPct !== undefined) data.seasonalityAdjustmentThresholdPct = seasonalityAdjustmentThresholdPct;
    if (receptionLeadTimeDays !== undefined) data.receptionLeadTimeDays = receptionLeadTimeDays;
    if (useReceptionLeadTimeInCalculation !== undefined) data.useReceptionLeadTimeInCalculation = useReceptionLeadTimeInCalculation;
    if (excludeGenericArticlesBelowPrice !== undefined) data.excludeGenericArticlesBelowPrice = excludeGenericArticlesBelowPrice;
    if (recentOrderMaxAgeDays !== undefined) data.recentOrderMaxAgeDays = recentOrderMaxAgeDays;
    if (forecastEnabled !== undefined) data.forecastEnabled = forecastEnabled;
    if (forecastAlpha !== undefined) data.forecastAlpha = forecastAlpha;
    if (ignoreRposStockInCalculation !== undefined) data.ignoreRposStockInCalculation = ignoreRposStockInCalculation;

    const results = [];
    for (const shopId of shopIds) {
      const config = await upsertConfig(shopId, data, req.user.email);
      results.push(config);
    }

    res.json({ success: true, data: { updated: results.length, configs: results } });
  } catch (error) {
    console.error('Bulk update config error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/system-config - configuration globale (ADMIN uniquement)
router.get('/system-config', requireAdmin, async (req, res) => {
  try {
    const config = await systemConfig.getAll();
    res.json({ success: true, data: config });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/system-config/chatbot-tools - noms d'outils valides pour une règle de
// détection d'intention (menu déroulant du formulaire d'édition, demande du 16/09/2026) — source
// unique avec la validation serveur (VALID_INTENT_TOOLS dans chatbotService.js), jamais une copie
// devinée côté frontend qui pourrait diverger si un outil est ajouté/retiré plus tard.
router.get('/system-config/chatbot-tools', requireAdmin, async (req, res) => {
  res.json({ success: true, data: [...VALID_INTENT_TOOLS].sort() });
});

// GET /api/reassort/system-config/jobs-health - état des 4 jobs planifiés (dernier statut, nombre
// d'échecs consécutifs) : les échecs de cron n'étaient auparavant visibles que dans les logs
// serveur, sans aucun moyen de les consulter depuis l'UI.
router.get('/system-config/jobs-health', requireAdmin, async (req, res) => {
  try {
    const jobsHealth = await jobHealthService.getJobsHealth();
    res.json({ success: true, data: jobsHealth });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/reassort/system-config - met à jour une clé de configuration globale (ADMIN uniquement)
// body: { key, value }
router.put('/system-config', requireAdmin, async (req, res) => {
  try {
    let { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ success: false, message: 'key et value sont requis' });
    }
    if (!Object.values(systemConfig.KEYS).includes(key)) {
      return res.status(400).json({ success: false, message: 'Clé de configuration inconnue' });
    }
    // systemConfig.value est un champ String en base — un appelant qui envoie un Number/Boolean JS
    // brut (ex: JSON.stringify({ value: 0.1 }) sans .toString()) faisait planter Prisma avec une
    // erreur peu claire ("Expected String, provided Float"), jamais renvoyée proprement au client
    // (bug trouvé le 21/09/2026 : REVISION_CHANGE_THRESHOLD). Conversion défensive ici, en plus du
    // correctif côté frontend — jamais faire confiance uniquement au client pour le bon type.
    if (typeof value !== 'string') value = String(value);

    const CRON_KEYS = [
      systemConfig.KEYS.NIGHTLY_PROPOSAL_CRON,
      systemConfig.KEYS.RECEPTION_SYNC_CRON,
      systemConfig.KEYS.SALES_SYNC_CRON,
      systemConfig.KEYS.SHOPS_SYNC_CRON,
      systemConfig.KEYS.DAILY_REVIEW_CRON,
      systemConfig.KEYS.PREDICTION_OUTCOME_CRON,
    ];
    if (CRON_KEYS.includes(key)) {
      const cron = require('node-cron');
      if (!cron.validate(value)) {
        return res.status(400).json({ success: false, message: 'Expression cron invalide' });
      }
    }

    if (key === systemConfig.KEYS.REVISION_CHANGE_THRESHOLD) {
      const threshold = parseFloat(value);
      if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
        return res.status(400).json({ success: false, message: 'Seuil invalide : nombre entre 0 et 1 (ex: 0.10 pour 10%)' });
      }
    }

    if (key === systemConfig.KEYS.ANOMALY_MIN_DAILY_SALES) {
      const threshold = parseFloat(value);
      if (!Number.isFinite(threshold) || threshold < 0) {
        return res.status(400).json({ success: false, message: 'Seuil invalide : nombre positif ou nul, en unités/jour (ex: 1, 0.5, 0)' });
      }
    }

    const ENABLED_KEYS = [
      systemConfig.KEYS.NIGHTLY_PROPOSAL_ENABLED,
      systemConfig.KEYS.RECEPTION_SYNC_ENABLED,
      systemConfig.KEYS.SALES_SYNC_ENABLED,
      systemConfig.KEYS.SHOPS_SYNC_ENABLED,
      systemConfig.KEYS.DAILY_REVIEW_ENABLED,
      systemConfig.KEYS.PREDICTION_OUTCOME_ENABLED,
      systemConfig.KEYS.AI_QUANTITY_ADJUSTMENT_ENABLED,
      systemConfig.KEYS.CHATBOT_LLM_FALLBACK_ENABLED,
    ];
    if (ENABLED_KEYS.includes(key) && !['true', 'false'].includes(value)) {
      return res.status(400).json({ success: false, message: 'Valeur invalide : "true" ou "false" attendu' });
    }

    if (key === systemConfig.KEYS.JWT_EXPIRES_IN && !/^\d+\s*(s|m|h|d)$/.test(value.trim())) {
      return res.status(400).json({ success: false, message: 'Durée invalide (format attendu : ex. "30m", "12h", "7d")' });
    }

    if (key === systemConfig.KEYS.LAST_SALE_SEARCH_WINDOWS_DAYS) {
      const windows = value.split(',').map((s) => s.trim());
      if (!windows.length || windows.some((w) => !/^\d+$/.test(w) || parseInt(w, 10) <= 0)) {
        return res.status(400).json({ success: false, message: 'Liste invalide : entiers positifs séparés par des virgules (ex: 31,93,366)' });
      }
    }

    // Règles de détection d'intention du chatbot (demande du 16/09/2026 : rendre la table dynamique
    // plutôt que codée en dur) — validées ICI, à l'écriture, plutôt que de laisser une règle
    // malformée passer et être filtrée silencieusement par chatbotService.getIntentRules à chaque
    // lecture : un admin qui enregistre une règle invalide doit le savoir immédiatement, pas
    // découvrir plus tard que sa règle n'a jamais été appliquée.
    if (key === systemConfig.KEYS.CHATBOT_INTENT_RULES) {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch (err) {
        return res.status(400).json({ success: false, message: 'JSON invalide : ' + err.message });
      }
      if (!Array.isArray(parsed) || !parsed.length) {
        return res.status(400).json({ success: false, message: 'Au moins une règle est requise (tableau non vide)' });
      }
      for (const [i, rule] of parsed.entries()) {
        if (!rule || !Array.isArray(rule.keywords) || !rule.keywords.length || rule.keywords.some((k) => typeof k !== 'string' || !k.trim())) {
          return res.status(400).json({ success: false, message: `Règle ${i + 1} : au moins un mot-clé non vide est requis` });
        }
        if (!VALID_INTENT_TOOLS.has(rule.tool)) {
          return res.status(400).json({ success: false, message: `Règle ${i + 1} : outil "${rule.tool}" inconnu` });
        }
      }
    }

    await systemConfig.setValue(key, value);

    // Certains changements doivent prendre effet immédiatement, pas seulement au prochain
    // rafraîchissement de cache ou redémarrage.
    if ([systemConfig.KEYS.RPOS_RETRY_ATTEMPTS, systemConfig.KEYS.RPOS_RETRY_DELAY_MS].includes(key)) {
      rpos.invalidateRposConfigCache();
    }
    if ([systemConfig.KEYS.NIGHTLY_PROPOSAL_CRON, systemConfig.KEYS.NIGHTLY_PROPOSAL_ENABLED].includes(key)) {
      const { startOrRestartNightlyJob } = require('../../jobs/cronManager');
      await startOrRestartNightlyJob();
    }
    if ([systemConfig.KEYS.RECEPTION_SYNC_CRON, systemConfig.KEYS.RECEPTION_SYNC_ENABLED].includes(key)) {
      const { startOrRestartReceptionSyncJob } = require('../../jobs/cronManager');
      await startOrRestartReceptionSyncJob();
    }
    if ([systemConfig.KEYS.SALES_SYNC_CRON, systemConfig.KEYS.SALES_SYNC_ENABLED].includes(key)) {
      const { startOrRestartSalesSyncJob } = require('../../jobs/cronManager');
      await startOrRestartSalesSyncJob();
    }
    if ([systemConfig.KEYS.SHOPS_SYNC_CRON, systemConfig.KEYS.SHOPS_SYNC_ENABLED].includes(key)) {
      const { startOrRestartShopsSyncJob } = require('../../jobs/cronManager');
      await startOrRestartShopsSyncJob();
    }
    if ([systemConfig.KEYS.DAILY_REVIEW_CRON, systemConfig.KEYS.DAILY_REVIEW_ENABLED].includes(key)) {
      const { startOrRestartDailyReviewJob } = require('../../jobs/cronManager');
      await startOrRestartDailyReviewJob();
    }
    if ([systemConfig.KEYS.PREDICTION_OUTCOME_CRON, systemConfig.KEYS.PREDICTION_OUTCOME_ENABLED].includes(key)) {
      const { startOrRestartPredictionOutcomeJob } = require('../../jobs/cronManager');
      await startOrRestartPredictionOutcomeJob();
    }

    res.json({ success: true, data: { key, value: systemConfig.SENSITIVE_KEYS.has(key) ? '••••••••' : value } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/system-config/sales-files-check?shop=<reference> - vérifie l'accès au dossier
// et liste les fichiers trouvés pour un code magasin (utile pour valider la config depuis l'UI)
router.get('/system-config/sales-files-check', requireAdmin, async (req, res) => {
  try {
    const shopReference = req.query.shopReference;
    const baseDir = await systemConfig.getValue(systemConfig.KEYS.SALES_FILES_DIR);
    const fs = require('fs');
    const dirAccessible = fs.existsSync(baseDir);
    // Cherche aussi dans MANUAL_IMPORT_DIR (les fichiers déposés via "Importer un fichier
    // d'export" ci-dessus atterrissent là, jamais dans baseDir) — sans ça, un fichier uploadé
    // manuellement n'apparaissait jamais dans cette vérification, même bien présent sur le
    // serveur (trouvé le 18/09/2026 : "Vérifier" ne cherchait que le dossier réseau partagé).
    const files = shopReference ? findSalesFiles([baseDir, MANUAL_IMPORT_DIR], shopReference) : [];
    res.json({ success: true, data: { baseDir, dirAccessible, files } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/system-config/sales-files-import-to-db - intègre RÉELLEMENT dans SalesLine un
// fichier déjà présent sur le serveur (déposé via upload web ou copié manuellement), sans repasser
// par un nouvel upload (demande du 18/09/2026 : un fichier déjà déposé avant que ce mécanisme
// n'existe reste sinon coincé, jamais intégré). Le chemin fourni doit être un résultat EXACT de
// findSalesFiles pour ce même shopReference — jamais un chemin arbitraire envoyé par le client
// (protection contre un chemin construit à la main qui pointerait ailleurs sur le disque).
router.post('/system-config/sales-files-import-to-db', requireAdmin, async (req, res) => {
  try {
    const { filePath, shopReference } = req.body;
    if (!filePath || !shopReference) {
      return res.status(400).json({ success: false, message: 'filePath et shopReference requis.' });
    }
    const baseDir = await systemConfig.getValue(systemConfig.KEYS.SALES_FILES_DIR);
    const knownFiles = findSalesFiles([baseDir, MANUAL_IMPORT_DIR], shopReference);
    if (!knownFiles.includes(filePath)) {
      return res.status(400).json({ success: false, message: 'Ce fichier n\'est pas reconnu pour ce magasin (relancez "Vérifier" pour rafraîchir la liste).' });
    }

    const result = await importCsvFileToDatabase(filePath, shopReference);
    res.json({
      success: true,
      message: `${result.imported} ligne(s) de vente intégrée(s) pour le magasin ${result.shopReference} (${result.shopName})${result.imported < result.totalLinesInFile ? ` — ${result.totalLinesInFile - result.imported} ligne(s) déjà présente(s), ignorée(s).` : '.'}`,
      data: result,
    });
  } catch (error) {
    console.error('Sales file import-to-db error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/system-config/sales-files-upload - dépose un fichier d'export de ventes CSV
// directement dans le dossier surveillé, sans avoir besoin d'un accès manuel au partage réseau
// (ex: import d'un historique ancien fourni par un collègue, hors du flux FTP automatique habituel).
// Validation du nom et du dossier faite dans salesFileUpload (storage.filename/destination, appelées
// avant toute écriture) — cette route n'a plus qu'à confirmer le résultat, streaming déjà terminé.
router.post('/system-config/sales-files-upload', requireAdmin, salesFileUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Aucun fichier reçu' });
    }

    // Import réel dans SalesLine (demande du 18/09/2026 : "je veux que ses fichier viennent dans
    // les ventes synchronisées aussi... comme les ventes aussi") — sans ça, le fichier restait un
    // CSV sur disque, lu seulement À LA DEMANDE à la génération d'une proposition, jamais visible
    // dans "Ventes synchronisées" ni exploitable par le chatbot. Le code magasin est le préfixe du
    // nom de fichier déjà validé par SALES_FILE_NAME_PATTERN (<code>_statvente-lignes_articles_...).
    // Une erreur d'import (magasin inconnu, fichier illisible) est signalée mais NE fait PAS
    // échouer l'upload lui-même : le fichier reste utilisable via readSalesLinesForPeriod à la
    // génération même si son import direct en base a échoué.
    const shopReference = req.file.filename.split('_')[0];
    let importResult = null;
    let importError = null;
    try {
      importResult = await importCsvFileToDatabase(req.file.path, shopReference);
    } catch (err) {
      importError = err.message;
      console.error(`[sales-files-upload] Échec de l'import en base pour ${req.file.filename} : ${err.message}`);
    }

    // Détail structuré (demande du 21/09/2026 : "affiche une fenêtre pour montrer les détails,
    // taille du fichier, nombre de ligne et nombre de ligne intégré et... si la donnée existe
    // déjà") — le frontend construit sa propre modale à partir de ces champs plutôt que de
    // parser le texte de "message" (conservé pour compatibilité/logs, mais plus la source de vérité
    // pour l'affichage détaillé).
    res.json({
      success: true,
      message: importResult
        ? `Fichier "${req.file.filename}" importé avec succès : ${importResult.imported} ligne(s) de vente ajoutée(s) pour le magasin ${importResult.shopReference} (${importResult.shopName})${importResult.imported < importResult.totalLinesInFile ? ` — ${importResult.totalLinesInFile - importResult.imported} ligne(s) déjà présente(s), ignorée(s).` : '.'}`
        : `Fichier "${req.file.filename}" déposé, mais son import dans les ventes synchronisées a échoué : ${importError}`,
      data: {
        fileName: req.file.filename,
        fileSizeBytes: req.file.size,
        importSucceeded: !!importResult,
        importError: importError || null,
        shopReference: importResult?.shopReference || shopReference,
        shopName: importResult?.shopName || null,
        totalLinesInFile: importResult?.totalLinesInFile ?? null,
        linesImported: importResult?.imported ?? null,
        linesAlreadyPresent: importResult ? (importResult.totalLinesInFile - importResult.imported) : null,
      },
    });
  } catch (error) {
    console.error('Sales file upload error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- IA (LLM) : gestion des clés API multi-fournisseurs et prévision à la demande ---

// GET /api/reassort/ai/keys - liste les clés configurées (ADMIN uniquement), sans jamais renvoyer
// la clé en clair : seul un aperçu masqué (4 derniers caractères) est exposé.
module.exports = router;
