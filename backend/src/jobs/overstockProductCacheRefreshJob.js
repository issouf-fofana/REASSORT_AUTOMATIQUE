/**
 * Job planifié : resynchronise ProductCache.stock (le stock RPOS "officiel", directement issu de
 * /api/product/) pour tous les articles ACTUELLEMENT en surstock — même besoin et même pattern que
 * stockoutProductCacheRefreshJob.js (créé le 19/10/2026 pour les ruptures EN_COURS), étendu le
 * 24/10/2026 après un cas confirmé en production : un article en surstock (donc plus proposé au
 * réassort, puisqu'il y en a déjà trop) n'est plus jamais revu par proposalService.js (qui alimente
 * ProductCache en cache-aside, TTL 15 min) ni par stockoutProductCacheRefreshJob.js (scopé aux
 * ruptures) — son ProductCache.stock peut donc rester périmé pendant des SEMAINES (cas constaté :
 * syncedAt du 18/09 alors que RPOS montrait déjà un stock totalement différent), faussant la
 * colonne Stock de la page Surstock qui s'appuie sur ce même stock live (overstockReportService.js).
 *
 * Portée volontairement limitée aux articles en surstock SNAPSHOT (getOverstockByShop, état
 * "maintenant", rapide) — jamais tout le catalogue, pour rester léger, même principe que le job
 * ruptures.
 */
const prisma = require('../utils/prisma');
const rpos = require('../services/rposClient');
const { mapWithConcurrency } = require('../utils/concurrency');
const { getOverstockByShop, DEFAULT_MIN_WEEKS_OF_COVERAGE } = require('../services/overstockReportService');

const SHOP_CONCURRENCY = 5; // même prudence que stockoutProductCacheRefreshJob.js

async function runOverstockProductCacheRefreshJob() {
  console.log('[overstockProductCacheRefreshJob] Resynchronisation démarrée...');

  const report = await getOverstockByShop(null, { minWeeksOfCoverage: DEFAULT_MIN_WEEKS_OF_COVERAGE });
  if (!report.found || !report.articles.length) {
    console.log('[overstockProductCacheRefreshJob] Aucun article en surstock, rien à resynchroniser.');
    return;
  }

  // getOverstockByShop ne renvoie pas rposPosId par article (seulement rposShopId) — résolu ici via
  // Shop, limité aux magasins effectivement concernés par du surstock.
  const shopIds = [...new Set(report.articles.map((a) => a.rposShopId))];
  const shops = await prisma.shop.findMany({ where: { rposShopId: { in: shopIds } }, select: { rposShopId: true, rposPosId: true } });
  const posIdByShop = new Map(shops.map((s) => [s.rposShopId, s.rposPosId]));

  // Groupé par (posId, shopId) — un magasin n'a qu'un seul posId, mais on ne suppose rien (même
  // garde-fou que stockoutProductCacheRefreshJob.js).
  const byShop = new Map();
  for (const a of report.articles) {
    const posId = posIdByShop.get(a.rposShopId);
    if (!posId) continue;
    const key = `${posId}::${a.rposShopId}`;
    if (!byShop.has(key)) byShop.set(key, { posId, shopId: a.rposShopId, eans: new Set() });
    byShop.get(key).eans.add(a.ean);
  }

  let updated = 0;
  await mapWithConcurrency([...byShop.values()], SHOP_CONCURRENCY, async ({ posId, shopId, eans }) => {
    try {
      const byEan = await rpos.getProductsByEans(posId, shopId, [...eans]);
      for (const [ean, product] of byEan) {
        await prisma.productCache.upsert({
          where: { rposShopId_ean: { rposShopId: shopId, ean } },
          update: { stock: Number(product.stock || 0), sellingPrice: Number(product.selling_price || 0), buyingPrice: Number(product.buying_price || 0) },
          create: {
            rposPosId: posId,
            rposShopId: shopId,
            ean,
            productId: product.id,
            orderable: !!product.orderable,
            sellingPrice: Number(product.selling_price || 0),
            buyingPrice: Number(product.buying_price || 0),
            orderingUnit: Number(product.ordering_unit || 1),
            stock: Number(product.stock || 0),
            departmentId: product.department?.id || null,
          },
        });
        updated += 1;
      }
    } catch (err) {
      console.error(`[overstockProductCacheRefreshJob] Échec pour le magasin ${shopId} (${posId}):`, err.message);
    }
  });

  console.log(`[overstockProductCacheRefreshJob] Terminé : ${updated} article(s) resynchronisé(s) sur ${report.articles.length} article(s) en surstock.`);
}

module.exports = { runOverstockProductCacheRefreshJob };
