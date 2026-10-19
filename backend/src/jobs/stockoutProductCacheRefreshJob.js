/**
 * Job planifié : resynchronise ProductCache.stock (le stock RPOS "officiel", directement issu de
 * /api/product/) pour tous les articles ayant une rupture EN_COURS — demande explicite du
 * 19/10/2026 : "le stckok afficher doit etre le stok tu pos" après que l'utilisateur ait signalé
 * un cas où le stock recalculé localement depuis StockMove (previousQuantity + quantity) reste
 * fortement négatif (-10000) alors qu'un arrivage prouve qu'il y a bien du stock physique — un
 * déficit accumulé par des mouvements historiques mal enregistrés ne doit jamais empêcher
 * d'afficher le vrai stock RPOS actuel.
 *
 * ProductCache.stock existe déjà (alimenté en cache-aside par proposalService.js lors de la
 * génération de propositions, TTL 15 min), mais un article jamais revu par une génération récente
 * peut rester synchronisé depuis des semaines (cas constaté : syncedAt du 18/09 alors qu'on est le
 * 19/10). Ce job cible spécifiquement les articles en rupture EN_COURS — jamais tout le catalogue,
 * pour rester léger — et les resynchronise régulièrement, indépendamment de l'activité des
 * propositions de commande.
 */
const prisma = require('../utils/prisma');
const rpos = require('../services/rposClient');
const { mapWithConcurrency } = require('../utils/concurrency');

const SHOP_CONCURRENCY = 5; // un appel RPOS groupé par lot de 200 EAN par magasin, concurrence prudente entre magasins

async function runStockoutProductCacheRefreshJob() {
  console.log('[stockoutProductCacheRefreshJob] Resynchronisation démarrée...');

  const openEpisodes = await prisma.stockoutEpisode.findMany({
    where: { status: 'EN_COURS' },
    select: { rposPosId: true, rposShopId: true, ean: true },
  });
  if (!openEpisodes.length) {
    console.log('[stockoutProductCacheRefreshJob] Aucune rupture EN_COURS, rien à resynchroniser.');
    return;
  }

  // Groupé par (posId, shopId) — un magasin n'a qu'un seul posId, mais on ne suppose rien.
  const byShop = new Map();
  for (const e of openEpisodes) {
    const key = `${e.rposPosId}::${e.rposShopId}`;
    if (!byShop.has(key)) byShop.set(key, { posId: e.rposPosId, shopId: e.rposShopId, eans: new Set() });
    byShop.get(key).eans.add(e.ean);
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
      console.error(`[stockoutProductCacheRefreshJob] Échec pour le magasin ${shopId} (${posId}):`, err.message);
    }
  });

  console.log(`[stockoutProductCacheRefreshJob] Terminé : ${updated} article(s) resynchronisé(s) sur ${openEpisodes.length} rupture(s) EN_COURS.`);
}

module.exports = { runStockoutProductCacheRefreshJob };
