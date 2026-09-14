const prisma = require('../utils/prisma');
const rpos = require('./rposClient');
const systemConfig = require('./systemConfigService');


/**
 * Dernier achat et dernière vente d'un produit, avec cache journalier (TTL configurable) pour
 * éviter de re-solliciter RPOS à chaque rechargement de la page de proposition : la première
 * consultation dans la fenêtre de validité interroge RPOS, les suivantes lisent le cache.
 */
async function getProductInsight(posId, shopId, productId, ean) {
  const ttlHours = parseFloat(await systemConfig.getValue(systemConfig.KEYS.PRODUCT_INSIGHT_CACHE_TTL_HOURS)) || 24;

  const cached = await prisma.productInsightCache.findUnique({
    where: { rposPosId_rposShopId_productId: { rposPosId: posId, rposShopId: shopId, productId } },
  });

  const isFresh = cached && Date.now() - new Date(cached.fetchedAt).getTime() < ttlHours * 60 * 60 * 1000;
  if (isFresh) {
    return {
      lastPurchase: cached.lastPurchaseDate
        ? { date: cached.lastPurchaseDate, quantity: cached.lastPurchaseQuantity, orderReference: cached.lastPurchaseOrderRef }
        : null,
      lastSale: cached.lastSaleDate ? { date: cached.lastSaleDate, quantity: cached.lastSaleQuantity } : null,
    };
  }

  const [lastPurchaseRaw, lastSaleRaw] = await Promise.all([
    rpos.getLastPurchaseForProduct(posId, shopId, productId),
    ean ? rpos.getLastSaleForProduct(posId, shopId, ean) : Promise.resolve(null),
  ]);

  // RPOS renvoie parfois les quantités sous forme de chaîne (ex: "5.000") : Prisma exige un
  // Float natif pour les colonnes numériques, d'où la coercition explicite avant écriture.
  const lastPurchase = lastPurchaseRaw
    ? { ...lastPurchaseRaw, quantity: lastPurchaseRaw.quantity !== null && lastPurchaseRaw.quantity !== undefined ? Number(lastPurchaseRaw.quantity) : null }
    : null;
  const lastSale = lastSaleRaw
    ? { ...lastSaleRaw, quantity: lastSaleRaw.quantity !== null && lastSaleRaw.quantity !== undefined ? Number(lastSaleRaw.quantity) : null }
    : null;

  await prisma.productInsightCache.upsert({
    where: { rposPosId_rposShopId_productId: { rposPosId: posId, rposShopId: shopId, productId } },
    update: {
      lastPurchaseDate: lastPurchase?.date ? new Date(lastPurchase.date) : null,
      lastPurchaseQuantity: lastPurchase?.quantity ?? null,
      lastPurchaseOrderRef: lastPurchase?.orderReference ?? null,
      lastSaleDate: lastSale?.date ? new Date(lastSale.date) : null,
      lastSaleQuantity: lastSale?.quantity ?? null,
      fetchedAt: new Date(),
    },
    create: {
      rposPosId: posId,
      rposShopId: shopId,
      productId,
      lastPurchaseDate: lastPurchase?.date ? new Date(lastPurchase.date) : null,
      lastPurchaseQuantity: lastPurchase?.quantity ?? null,
      lastPurchaseOrderRef: lastPurchase?.orderReference ?? null,
      lastSaleDate: lastSale?.date ? new Date(lastSale.date) : null,
      lastSaleQuantity: lastSale?.quantity ?? null,
    },
  });

  return { lastPurchase, lastSale };
}

module.exports = { getProductInsight };
