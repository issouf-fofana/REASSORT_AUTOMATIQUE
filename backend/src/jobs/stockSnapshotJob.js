/**
 * Job planifié : capture plusieurs fois par jour le stock de chaque article orderable=true (= actif
 * et réellement attendu dans le magasin, cf. rupture.md §2.1) depuis ProductCache, dans la table
 * StockSnapshot. Nécessaire pour dater le début/fin réel d'un épisode de rupture : ProductCache.stock
 * est écrasé à chaque sync RPOS (une seule valeur, pas d'historique), donc sans ce job impossible de
 * savoir QUAND un article est tombé à zéro.
 *
 * Pas d'appel RPOS ici : ProductCache est déjà tenu à jour par ailleurs (proposalService.js), ce job
 * se contente de dupliquer sa valeur courante dans une table append-only horodatée.
 */
const prisma = require('../utils/prisma');
const { detectStockoutEpisodes } = require('../services/stockoutEpisodeService');

const SNAPSHOT_BATCH_SIZE = 500;

async function runStockSnapshotJob() {
  console.log('[stockSnapshotJob] Capture démarrée...');

  const shops = await prisma.productCache.findMany({
    where: { orderable: true },
    select: { rposShopId: true },
    distinct: ['rposShopId'],
  });

  let totalSnapshots = 0;
  for (const { rposShopId } of shops) {
    const products = await prisma.productCache.findMany({
      where: { rposShopId, orderable: true },
      select: { rposPosId: true, rposShopId: true, ean: true, stock: true },
    });

    for (let i = 0; i < products.length; i += SNAPSHOT_BATCH_SIZE) {
      const batch = products.slice(i, i + SNAPSHOT_BATCH_SIZE);
      await prisma.stockSnapshot.createMany({
        data: batch.map((p) => ({
          rposPosId: p.rposPosId,
          rposShopId: p.rposShopId,
          ean: p.ean,
          stock: p.stock,
        })),
      });
      totalSnapshots += batch.length;
    }

    try {
      await detectStockoutEpisodes(rposShopId);
    } catch (err) {
      console.error(`[stockSnapshotJob] Détection d'épisodes échouée pour ${rposShopId}:`, err.message);
    }
  }

  console.log(`[stockSnapshotJob] Capture terminée : ${totalSnapshots} snapshot(s) sur ${shops.length} magasin(s).`);
}

module.exports = { runStockSnapshotJob };
