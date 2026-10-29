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
 * Portée volontairement limitée aux articles en surstock SNAPSHOT — lu depuis le rapport déjà
 * PRÉCALCULÉ par overstockReportSnapshotJob.js, jamais recalculé ici (BUG CORRIGÉ le 24/10/2026 :
 * la première version appelait getOverstockByShop EN DIRECT, qui recalcule tout le rapport sur
 * ~39 000 articles × 38 magasins — exactement le calcul coûteux, 56-97s en concurrence avec les
 * autres jobs de synchro, que overstockReportSnapshotJob.js a justement été créé pour éviter ;
 * observé en production : le job ne terminait toujours pas après plusieurs minutes alors que les
 * autres jobs de démarrage, bien plus légers, avaient déjà fini plusieurs fois dans l'intervalle).
 */
const prisma = require('../utils/prisma');
const rpos = require('../services/rposClient');
const { mapWithConcurrency } = require('../utils/concurrency');
const { getCachedDefaultOverstockReport } = require('../services/overstockReportService');
const { buildCacheKeys } = require('./overstockReportSnapshotJob');
const systemConfig = require('../services/systemConfigService');

const SHOP_CONCURRENCY = 5; // même prudence que stockoutProductCacheRefreshJob.js

async function runOverstockProductCacheRefreshJob() {
  console.log('[overstockProductCacheRefreshJob] Resynchronisation démarrée...');

  const minWeeksOfCoverage = parseFloat(await systemConfig.getValue(systemConfig.KEYS.OVERSTOCK_MIN_WEEKS_OF_COVERAGE)) || 4;
  const { cacheKey } = buildCacheKeys(minWeeksOfCoverage);
  const report = await getCachedDefaultOverstockReport(null, cacheKey);
  if (!report || !report.found || !report.articlesByShop.length) {
    console.log('[overstockProductCacheRefreshJob] Aucun snapshot Surstock disponible ou aucun article en surstock, rien à resynchroniser.');
    return;
  }

  // Le snapshot ne porte pas rposPosId par article (seulement rposShopId) — résolu ici via Shop,
  // limité aux magasins effectivement concernés par du surstock.
  const shopIds = [...new Set(report.articlesByShop.map((a) => a.rposShopId))];
  const shops = await prisma.shop.findMany({ where: { rposShopId: { in: shopIds } }, select: { rposShopId: true, rposPosId: true } });
  const posIdByShop = new Map(shops.map((s) => [s.rposShopId, s.rposPosId]));

  // Groupé par (posId, shopId) — un magasin n'a qu'un seul posId, mais on ne suppose rien (même
  // garde-fou que stockoutProductCacheRefreshJob.js).
  const byShop = new Map();
  for (const a of report.articlesByShop) {
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
        // BUG CORRIGÉ le 24/10/2026 (cf. même correctif dans stockoutProductCacheRefreshJob.js) :
        // syncedAt a `@default(now())`, qui ne s'applique qu'à la création — jamais réappliqué par
        // un upsert dont le bloc `update` ne le mentionne pas, rendant impossible de vérifier si un
        // article a vraiment été resynchronisé récemment.
        await prisma.productCache.upsert({
          where: { rposShopId_ean: { rposShopId: shopId, ean } },
          update: { stock: Number(product.stock || 0), sellingPrice: Number(product.selling_price || 0), buyingPrice: Number(product.buying_price || 0), syncedAt: new Date() },
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

  console.log(`[overstockProductCacheRefreshJob] Terminé : ${updated} article(s) resynchronisé(s) sur ${report.articlesByShop.length} article(s) en surstock.`);
}

module.exports = { runOverstockProductCacheRefreshJob };
