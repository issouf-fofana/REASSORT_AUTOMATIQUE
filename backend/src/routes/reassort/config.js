// Sous-routeur 'config' — Configuration magasin et systeme, fichiers de ventes, sante des jobs.
// Monte dans routes/reassort/index.js sous le prefixe /api/reassort (requireAuth +
// requireSupervisedShop appliques la-bas, pas ici). Ne jamais monter ailleurs.
const express = require('express');
const router = express.Router();
const { requireAdmin, resolveShopId } = require('../../middleware/auth');
const prisma = require('../../utils/prisma');
const rpos = require('../../services/rposClient');
const { getConfig, upsertConfig } = require('../../services/configService');
const { MODE_DAYS } = require('../../services/periodService');
const systemConfig = require('../../services/systemConfigService');
const { findSalesFiles } = require('../../services/salesFileService');
const jobHealthService = require('../../services/jobHealthService');
const multer = require('multer');
const path = require('path');
const fsPromises = require('fs/promises');

// Upload en memoire (fichiers de vente CSV, quelques Mo max) : on valide le nom et le contenu
// avant d'ecrire sur disque, jamais un stockage direct sur le dossier surveille par multer lui-meme.
const salesFileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.get('/config', async (req, res) => {
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
router.put('/config', async (req, res) => {
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

// PUT /api/reassort/config/bulk - applique les mêmes paramètres à plusieurs magasins (ADMIN uniquement)
// body: { shopIds: [uuid, ...], paretoThreshold, safetyStockRatio, periodMode, customStart, customEnd,
//         treatNegativeStockAsZero, revenueSharePeriodDays, overstockThresholdMultiplier, splitOrdersByDepartment, forecastAccuracyWindowDays, forecastAccuracyThresholdPct, seasonalityComparisonEnabled, seasonalityLookbackYears, seasonalityAdjustmentThresholdPct, receptionLeadTimeDays, useReceptionLeadTimeInCalculation, excludeGenericArticlesBelowPrice }
router.put('/config/bulk', async (req, res) => {
  try {
    if (req.user.role === 'STORE') {
      return res.status(403).json({ success: false, message: 'Réservé aux administrateurs et superviseurs' });
    }

    const {
      shopIds, paretoThreshold, safetyStockRatio, periodMode, customStart, customEnd,
      treatNegativeStockAsZero, revenueSharePeriodDays, overstockThresholdMultiplier, splitOrdersByDepartment, forecastAccuracyWindowDays, forecastAccuracyThresholdPct, seasonalityComparisonEnabled, seasonalityLookbackYears, seasonalityAdjustmentThresholdPct, receptionLeadTimeDays, useReceptionLeadTimeInCalculation, excludeGenericArticlesBelowPrice, recentOrderMaxAgeDays, forecastEnabled, forecastAlpha, ignoreRposStockInCalculation,
    } = req.body;
    if (!Array.isArray(shopIds) || shopIds.length === 0) {
      return res.status(400).json({ success: false, message: 'shopIds (tableau non vide) est requis' });
    }

    if (req.user.role === 'SUPERVISOR') {
      // Un superviseur ne peut appliquer une config en masse qu'à des magasins de son périmètre.
      const supervised = await prisma.supervisedShop.findMany({
        where: { userId: req.user.id, rposShopId: { in: shopIds } },
      });
      if (supervised.length !== shopIds.length) {
        return res.status(403).json({ success: false, message: 'Un ou plusieurs magasins ne sont pas dans votre périmètre de supervision' });
      }
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
    const { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ success: false, message: 'key et value sont requis' });
    }
    if (!Object.values(systemConfig.KEYS).includes(key)) {
      return res.status(400).json({ success: false, message: 'Clé de configuration inconnue' });
    }

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
    const files = dirAccessible && shopReference ? findSalesFiles(baseDir, shopReference) : [];
    res.json({ success: true, data: { baseDir, dirAccessible, files } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/system-config/sales-files-upload - dépose un fichier d'export de ventes CSV
// directement dans le dossier surveillé, sans avoir besoin d'un accès manuel au partage réseau
// (ex: import d'un historique ancien fourni par un collègue, hors du flux FTP automatique habituel).
// Nom de fichier strictement validé (même format que findSalesFiles) pour ne jamais écrire en
// dehors du dossier configuré ni accepter un fichier qui ne serait pas détecté ensuite.
const SALES_FILE_NAME_PATTERN = /^[a-zA-Z0-9]+_statvente-lignes_articles_[a-zA-Z0-9_-]+\.csv$/i;

router.post('/system-config/sales-files-upload', requireAdmin, salesFileUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Aucun fichier reçu' });
    }
    const originalName = req.file.originalname;
    if (!SALES_FILE_NAME_PATTERN.test(originalName)) {
      return res.status(400).json({
        success: false,
        message: `Nom de fichier invalide : "${originalName}". Format attendu : <code_magasin>_statvente-lignes_articles_<date>.csv (ex: 050_statvente-lignes_articles_01062024_0000.csv)`,
      });
    }

    const baseDir = await systemConfig.getValue(systemConfig.KEYS.SALES_FILES_DIR);
    if (!require('fs').existsSync(baseDir)) {
      return res.status(400).json({ success: false, message: `Le dossier configuré "${baseDir}" n'existe pas ou n'est pas accessible.` });
    }

    // path.basename() défend contre un nom de fichier contenant des séparateurs de chemin
    // (../, /) malgré la validation par regex ci-dessus — ceinture et bretelles sur un chemin
    // d'écriture disque construit à partir d'une entrée utilisateur.
    const safeName = path.basename(originalName);
    const destPath = path.join(baseDir, safeName);
    await fsPromises.writeFile(destPath, req.file.buffer);

    res.json({ success: true, message: `Fichier "${safeName}" importé avec succès dans ${baseDir}.` });
  } catch (error) {
    console.error('Sales file upload error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- IA (LLM) : gestion des clés API multi-fournisseurs et prévision à la demande ---

// GET /api/reassort/ai/keys - liste les clés configurées (ADMIN uniquement), sans jamais renvoyer
// la clé en clair : seul un aperçu masqué (4 derniers caractères) est exposé.
module.exports = router;
