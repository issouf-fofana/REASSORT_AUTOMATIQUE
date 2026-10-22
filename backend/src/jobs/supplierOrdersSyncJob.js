/**
 * Synchronise les commandes fournisseur RPOS vers un cache local (demande explicite du 22/10/2026 :
 * "ca prend du temps pour affiché" — Tableau de bord mesuré à 10-30s avant affichage, seul coupable
 * identifié parmi tous ses widgets : GET /reassort/orders appelait rpos.getSupplierOrders() en
 * direct à CHAQUE chargement de page, un vrai aller-retour réseau vers le serveur RPOS du magasin,
 * potentiellement lent selon sa charge — même type de lenteur déjà rencontré ailleurs cette session
 * pour d'autres appels RPOS). Ce job tourne en tâche de fond ; la route /orders lit désormais
 * SupplierOrderCache, instantané, au lieu d'attendre RPOS en direct à chaque visite.
 */
const prisma = require('../utils/prisma');
const rpos = require('../services/rposClient');
const { mapWithConcurrency } = require('../utils/concurrency');

const SYNC_CONCURRENCY = 10;

async function runSupplierOrdersSyncJob() {
  console.log('[supplierOrdersSyncJob] Synchronisation démarrée...');

  const shops = await prisma.shop.findMany({ select: { rposShopId: true, rposPosId: true } });
  let shopsOk = 0;
  let shopsFailed = 0;

  await mapWithConcurrency(shops, SYNC_CONCURRENCY, async (shop) => {
    try {
      const data = await rpos.getSupplierOrders(shop.rposPosId, { shopId: shop.rposShopId, pageSize: 50, page: 1 });
      const rows = (data.results || []).map((o) => ({
        rposShopId: shop.rposShopId,
        rposPosId: shop.rposPosId,
        rposOrderId: String(o.id),
        reference: o.reference || '',
        externalReference: o.external_reference || null,
        date: o.date ? new Date(o.date) : null,
        deliveryDate: o.delivery_date ? new Date(o.delivery_date) : null,
        statusDisplay: o.status_display || '',
        supplierCode: o.supplier?.code || null,
        supplierName: o.supplier?.name || null,
        createdBy: o.created_by || null,
      }));

      // Remplace TOUTES les lignes du magasin plutôt qu'un upsert ligne à ligne — une commande
      // supprimée côté RPOS (cas déjà géré par la route /orders via ProposalOrder.rposOrderId, cf.
      // shops.js) ne doit pas rester indéfiniment dans ce cache sous prétexte qu'aucun upsert ne
      // l'a jamais retirée ; un simple delete+insert dans une transaction évite ce risque de dérive
      // sans complexifier le job avec un diff ligne à ligne pour un volume de toute façon modeste
      // (pageSize=50 par magasin).
      await prisma.$transaction([
        prisma.supplierOrderCache.deleteMany({ where: { rposShopId: shop.rposShopId } }),
        prisma.supplierOrderCache.createMany({ data: rows }),
      ]);
      shopsOk += 1;
    } catch (err) {
      shopsFailed += 1;
      console.error(`[supplierOrdersSyncJob] Échec pour le magasin ${shop.rposShopId} (${shop.rposPosId}) : ${err.message}`);
    }
  });

  console.log(`[supplierOrdersSyncJob] Synchronisation terminée : ${shopsOk} magasin(s) à jour, ${shopsFailed} échec(s).`);
}

module.exports = { runSupplierOrdersSyncJob };
