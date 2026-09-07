const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const DEFAULTS = {
  paretoThreshold: 0.80,
  safetyStockRatio: 0.5,
  periodMode: 'LAST_30_DAYS',
  customStart: null,
  customEnd: null,
  treatNegativeStockAsZero: true,
  revenueSharePeriodDays: 1,
  overstockThresholdMultiplier: 1.5,
  splitOrdersByDepartment: true,
  forecastAccuracyWindowDays: 7,
  forecastAccuracyThresholdPct: 20,
  seasonalityComparisonEnabled: false,
  seasonalityLookbackYears: 1,
  seasonalityAdjustmentThresholdPct: 15,
  receptionLeadTimeDays: 1,
  useReceptionLeadTimeInCalculation: false,
  excludeGenericArticlesBelowPrice: 2,
  recentOrderMaxAgeDays: 3,
  forecastEnabled: false,
  forecastAlpha: 0.3,
};

/** Récupère la config d'un magasin, ou les valeurs par défaut si aucune n'a été personnalisée. */
async function getConfig(shopId) {
  const config = await prisma.reassortConfig.findUnique({ where: { rposShopId: shopId } });
  return config || { rposShopId: shopId, ...DEFAULTS };
}

async function upsertConfig(shopId, data, updatedBy) {
  return prisma.reassortConfig.upsert({
    where: { rposShopId: shopId },
    update: { ...data, updatedBy },
    create: { rposShopId: shopId, ...DEFAULTS, ...data, updatedBy },
  });
}

module.exports = { getConfig, upsertConfig, DEFAULTS };
