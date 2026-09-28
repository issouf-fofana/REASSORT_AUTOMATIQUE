const prisma = require('../utils/prisma');


const DEFAULTS = {
  paretoThreshold: 0.80,
  safetyStockRatio: 0.5,
  // Changé de LAST_30_DAYS à LAST_365_DAYS le 28/09/2026 (demande explicite : "je veux que l'analyse
  // par défaut soit sur 1 an") — période glissante sur la dernière vente réelle, jamais bloquante si
  // le magasin a moins d'un an d'historique : le calcul se fait alors simplement sur les données
  // réellement disponibles dans cette fenêtre (cf. periodService.js resolvePeriod). N'affecte que
  // les magasins SANS configuration personnalisée en base (ReassortConfig) — un magasin déjà réglé
  // explicitement sur un autre mode garde son réglage, inchangé par ce changement de défaut.
  periodMode: 'LAST_365_DAYS',
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
  // Si vrai, la génération n'appelle jamais RPOS pour le stock/prix/colisage d'un article déjà vu
  // au moins une fois (ProductCache utilisé même très périmé, TTL ignoré) — permet de générer une
  // proposition en étant hors du réseau Prosuma, au prix d'un stock potentiellement obsolète (mis à
  // 0 dans le calcul, jamais utilisé comme une vraie valeur non fiable). Un article jamais vu (aucun
  // cache) reste exclu, faute de prix/colisage connus. Off par défaut : le stock réel reste le
  // comportement normal et le plus fiable, à activer explicitement en connaissance de cause.
  ignoreRposStockInCalculation: false,
  // Mode Auto (23/09/2026) : off par défaut, n'affecte aucun magasin sans activation explicite.
  autoOrderEnabled: false,
  autoOrderValidateAfterCreate: false,
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
