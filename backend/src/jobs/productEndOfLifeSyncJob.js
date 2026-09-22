/**
 * Synchronise localement les DLV actives (end_of_life_product) de chaque serveur RPOS — demande du
 * 22/09/2026 : le calcul de réassort doit retirer le stock parti en DLV du stock "normal" pris en
 * compte pour l'article d'origine, pour ne jamais sous-estimer un vrai besoin de réassort à cause
 * d'un stock qui traîne à prix réduit sur un EAN séparé (cf. schema.prisma#ProductEndOfLife).
 *
 * Un seul appel par SERVEUR (pas par magasin) : confirmé par test direct que cette table RPOS est
 * globale au groupe, pas filtrable par magasin côté requête — voir le commentaire de
 * rposClient.getAllEndOfLifeProducts pour le détail. Remplace tout le contenu à chaque passage
 * (deleteMany + createMany) plutôt qu'un upsert par ligne : le volume total (~6000 lignes sur le
 * serveur observé) reste largement gérable en une transaction, et une DLV clôturée entre-temps côté
 * RPOS (donc absente de la nouvelle réponse) doit disparaître de la base locale, pas y rester.
 */
const prisma = require('../utils/prisma');
const rpos = require('../services/rposClient');
const rposServers = require('../services/rposServersService');

async function syncServer(server) {
  let rows;
  try {
    rows = await rpos.getAllEndOfLifeProducts(server.posId);
  } catch (err) {
    console.error(`[productEndOfLifeSyncJob] Impossible de récupérer les DLV de ${server.posId}:`, err.message);
    return 0;
  }

  await prisma.$transaction([
    prisma.productEndOfLife.deleteMany({ where: { rposPosId: server.posId } }),
    prisma.productEndOfLife.createMany({
      data: rows.map((r) => ({
        rposId: r.rposId,
        rposPosId: server.posId,
        rposShopId: r.shopId,
        dlvEan: r.dlvEan,
        originEan: r.originEan,
        label: r.label,
        dlvStock: r.dlvStock,
        sellingPrice: r.sellingPrice,
      })),
      skipDuplicates: true,
    }),
  ]);

  console.log(`[productEndOfLifeSyncJob] ${server.posId} : ${rows.length} DLV active(s) synchronisée(s)`);
  return rows.length;
}

async function runProductEndOfLifeSync() {
  const servers = await rposServers.listServers();
  const activeServers = servers.filter((s) => s.isActive && s.rposUser && s.rposPassword);

  console.log(`[productEndOfLifeSyncJob] Synchronisation démarrée sur ${activeServers.length} serveur(s)...`);
  let total = 0;
  for (const server of activeServers) {
    total += await syncServer(server);
  }
  console.log(`[productEndOfLifeSyncJob] Synchronisation terminée : ${total} DLV active(s) au total.`);
}

module.exports = { runProductEndOfLifeSync };
