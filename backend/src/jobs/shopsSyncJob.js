/**
 * Synchronise localement la liste des magasins de chaque serveur RPOS actif, pour que le menu
 * déroulant "Magasin" (utilisé sur toutes les pages admin) lise la base locale au lieu d'interroger
 * RPOS en direct sur potentiellement 18 serveurs à chaque premier chargement de page (observé :
 * jusqu'à 15-20s de latence sur cache-miss). La liste des magasins change très rarement (ajout ou
 * fermeture manuelle), donc une synchro toutes les heures suffit largement.
 */
const prisma = require('../utils/prisma');
const rpos = require('../services/rposClient');
const rposServers = require('../services/rposServersService');


async function runShopsSync() {
  const servers = await rposServers.listServers();
  const activeServers = servers.filter((s) => s.isActive && s.rposUser && s.rposPassword);

  console.log(`[shopsSyncJob] Synchronisation démarrée sur ${activeServers.length} serveur(s)...`);

  // Les serveurs sont des hôtes RPOS distincts (indépendants entre eux) : traités en parallèle.
  // Les upserts Shop d'un même serveur restent purement locaux (Postgres), donc en parallèle aussi
  // sans risque de saturer RPOS (audit performance : tout était strictement séquentiel avant).
  await Promise.all(activeServers.map(async (server) => {
    try {
      const shops = await rpos.getShops(server.posId);
      await Promise.all(shops.map((shop) => prisma.shop.upsert({
        where: { rposShopId: shop.id },
        update: { rposPosId: server.posId, reference: shop.reference, name: shop.name, syncedAt: new Date() },
        create: { rposShopId: shop.id, rposPosId: server.posId, reference: shop.reference, name: shop.name },
      })));
      console.log(`[shopsSyncJob] ${server.posId} : ${shops.length} magasin(s) synchronisé(s)`);
    } catch (err) {
      console.error(`[shopsSyncJob] Échec pour ${server.posId}:`, err.message);
    }
  }));

  console.log('[shopsSyncJob] Synchronisation terminée.');
}

module.exports = { runShopsSync };
