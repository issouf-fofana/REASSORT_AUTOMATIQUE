// Sous-routeur 'shops' — Magasins/serveurs RPOS, commandes fournisseurs, statuts de reception.
// Monte dans routes/reassort/index.js sous le prefixe /api/reassort (requireAuth +
// requireSupervisedShop appliques la-bas, pas ici). Ne jamais monter ailleurs.
const express = require('express');
const router = express.Router();
const { requireAuth, requireAdmin, resolveShopId, resolvePosId, requireSupervisedShop } = require('../../middleware/auth');
const prisma = require('../../utils/prisma');
const rpos = require('../../services/rposClient');
const rposServers = require('../../services/rposServersService');

router.get('/servers', requireAdmin, async (req, res) => {
  try {
    const servers = await rposServers.listServers();
    const forceRefresh = req.query.refresh === 'true';

    let results;
    if (forceRefresh) {
      // 18 serveurs interrogés en parallèle (hôtes RPOS distincts, indépendants) plutôt qu'en
      // série (audit performance) : cette route bloquait sinon la réponse HTTP jusqu'à la fin du
      // dernier serveur, potentiellement plusieurs dizaines de secondes cumulées.
      results = await Promise.all(servers.map(async (server) => {
        let shops = [];
        let error = null;

        if (server.isActive && server.rposUser && server.rposPassword) {
          try {
            shops = await rpos.getShops(server.posId);
          } catch (err) {
            error = err.message;
          }
        }

        return {
          posId: server.posId,
          label: server.label,
          baseUrl: server.baseUrl,
          rposUser: server.rposUser || '',
          isActive: server.isActive,
          hasCredentials: !!(server.rposUser && server.rposPassword),
          shops,
          error,
          source: 'rpos',
        };
      }));
    } else {
      const allShops = await prisma.shop.findMany({ orderBy: { reference: 'asc' } });
      const shopsByPosId = new Map();
      for (const shop of allShops) {
        if (!shopsByPosId.has(shop.rposPosId)) shopsByPosId.set(shop.rposPosId, []);
        shopsByPosId.get(shop.rposPosId).push({ id: shop.rposShopId, reference: shop.reference, name: shop.name });
      }

      results = servers.map((server) => ({
        posId: server.posId,
        label: server.label,
        baseUrl: server.baseUrl,
        rposUser: server.rposUser || '',
        isActive: server.isActive,
        hasCredentials: !!(server.rposUser && server.rposPassword),
        shops: shopsByPosId.get(server.posId) || [],
        error: null,
        source: 'local',
      }));
    }

    res.json({ success: true, data: results });
  } catch (error) {
    console.error('List servers error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/reassort/servers/:posId - configure les identifiants d'un serveur RPOS (ADMIN uniquement)
// body: { baseUrl, rposUser, rposPassword }
router.put('/servers/:posId', requireAdmin, async (req, res) => {
  try {
    const { baseUrl, rposUser, rposPassword } = req.body;
    const server = await rposServers.upsertServerCredentials(req.params.posId, { baseUrl, rposUser, rposPassword });
    rpos.invalidateRposConfigCache(req.params.posId);
    res.json({
      success: true,
      data: { posId: server.posId, baseUrl: server.baseUrl, rposUser: server.rposUser, isActive: server.isActive },
    });
  } catch (error) {
    console.error('Update server error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/shops - liste des magasins du serveur de l'utilisateur, ou de tous les
// serveurs actifs pour un ADMIN sans ?pos=, ou d'un serveur précis avec ?pos=<posId>
router.get('/shops', async (req, res) => {
  try {
    if (req.user.role === 'SUPERVISOR') {
      // Un superviseur ne voit que les magasins de son périmètre, pas tous les magasins actifs.
      const supervised = await prisma.supervisedShop.findMany({ where: { userId: req.user.id } });
      return res.json({
        success: true,
        data: supervised.map((s) => ({
          id: s.rposShopId, reference: s.rposShopReference, name: s.rposShopName,
          posId: s.rposPosId,
        })),
      });
    }
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ success: false, message: 'Réservé aux administrateurs et superviseurs' });
    }

    const posId = req.query.pos;
    if (posId) {
      const shops = await rpos.getShops(posId);
      return res.json({ success: true, data: shops.map((s) => ({ ...s, posId })) });
    }

    // Sans posId précisé : agrège les magasins de tous les serveurs actifs configurés. Lit d'abord
    // la copie locale (table Shop, synchronisée en tâche de fond par shopsSyncJob.js) plutôt que
    // d'interroger RPOS en direct sur potentiellement 18 serveurs à chaque appel (jusqu'à 15-20s
    // de latence observée) : la liste des magasins change très rarement. Repli sur RPOS en direct
    // uniquement si la table est vide (tout premier démarrage, avant la première synchro).
    const servers = await rposServers.listServers();
    const activeServers = servers.filter((s) => s.isActive && s.rposUser && s.rposPassword);
    const activePosIds = new Set(activeServers.map((s) => s.posId));
    const posLabelById = new Map(activeServers.map((s) => [s.posId, s.label]));

    const localShops = await prisma.shop.findMany({ where: { rposPosId: { in: Array.from(activePosIds) } } });
    if (localShops.length > 0) {
      return res.json({
        success: true,
        data: localShops.map((s) => ({
          id: s.rposShopId, reference: s.reference, name: s.name,
          posId: s.rposPosId, posLabel: posLabelById.get(s.rposPosId),
        })),
      });
    }

    const results = await Promise.allSettled(
      activeServers.map((server) => rpos.getShops(server.posId))
    );
    const allShops = [];
    results.forEach((result, i) => {
      const server = activeServers[i];
      if (result.status === 'fulfilled') {
        allShops.push(...result.value.map((s) => ({ ...s, posId: server.posId, posLabel: server.label })));
      } else {
        console.error(`[shops] Échec sur ${server.posId}:`, result.reason?.message);
      }
    });
    res.json({ success: true, data: allShops });
  } catch (error) {
    console.error('RPOS shops error:', error);
    res.status(502).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/orders?page=<n> - liste les commandes fournisseur du magasin de l'utilisateur
// (ou ?shop=<id>&pos=<posId> pour un ADMIN consultant un magasin précis). Inclut aussi les
// commandes que notre plateforme a créées mais qui ont depuis été supprimées côté RPOS.
router.get('/orders', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    const page = req.query.page ? parseInt(req.query.page, 10) : 1;

    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    const data = await rpos.getSupplierOrders(posId, { shopId, page });
    const currentOrderIds = new Set((data.results || []).map((o) => o.id));

    const orders = (data.results || []).map((o) => ({
      ...o,
      external_reference: (o.external_reference || '').replace('[REASSORT-IA]', '').trim(),
      deletedOnRpos: false,
    }));

    // Commandes créées par ce système (une par rayon, readme §11) qui n'apparaissent plus dans la
    // liste active RPOS (supprimées depuis côté RPOS) : on les rajoute avec un marqueur d'affichage.
    const proposalOrders = await prisma.proposalOrder.findMany({
      where: { proposal: { rposShopId: shopId, status: 'VALIDATED' }, rposOrderId: { not: null } },
      include: { proposal: { select: { validatedBy: true, validatedAt: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const deletedOrders = proposalOrders
      .filter((o) => !currentOrderIds.has(o.rposOrderId))
      .map((o) => ({
        id: o.rposOrderId,
        reference: o.rposOrderReference,
        external_reference: o.department !== 'Toutes lignes' ? o.department : '',
        date: o.proposal.validatedAt,
        delivery_date: null,
        status_display: 'supprimée',
        supplier: null,
        created_by: o.proposal.validatedBy,
        deletedOnRpos: true,
      }));

    res.json({
      success: true,
      data: {
        orders: [...orders, ...deletedOrders],
        count: (data.count || 0) + deletedOrders.length,
        nextPage: data.next_page || null,
      },
    });
  } catch (error) {
    console.error('Orders list error:', error);
    res.status(502).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/orders/:rposOrderId/detail - détail des articles envoyés pour une commande
// RPOS donnée (un rayon), retrouvé via ProposalOrder (readme §11), avec repli sur l'ancien
// rposOrderId de Proposal pour les commandes créées avant la séparation par rayon.
router.get('/orders/:rposOrderId/detail', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    const proposalOrder = await prisma.proposalOrder.findFirst({
      where: { rposOrderId: req.params.rposOrderId, proposal: { rposShopId: shopId, status: 'VALIDATED' } },
      include: { proposal: { include: { lines: { where: { wasExcluded: false } } } } },
    });

    if (proposalOrder) {
      const isSplit = proposalOrder.department !== 'Toutes lignes';
      const lines = isSplit
        ? proposalOrder.proposal.lines.filter((l) => (l.department || 'Sans rayon') === proposalOrder.department)
        : proposalOrder.proposal.lines;
      return res.json({ success: true, data: { ...proposalOrder.proposal, lines } });
    }

    // Repli : anciennes commandes créées avant l'introduction de ProposalOrder.
    const proposal = await prisma.proposal.findFirst({
      where: { rposShopId: shopId, rposOrderId: req.params.rposOrderId, status: 'VALIDATED' },
      include: { lines: { where: { wasExcluded: false } } },
    });

    if (!proposal) {
      return res.status(404).json({ success: false, message: 'Détail non disponible pour cette commande (créée avant l\'historisation, ou par un autre moyen que ce système)' });
    }

    res.json({ success: true, data: proposal });
  } catch (error) {
    console.error('Order detail error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/orders/:rposOrderId/cancel - annule une commande fournisseur sur RPOS
// (statut "annulée"), typiquement pour nettoyer une commande de test ou créée par erreur.
// Réservé ADMIN : action irréversible sur RPOS, affecte potentiellement l'entrepôt.
router.post('/orders/:rposOrderId/cancel', requireAdmin, async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    // Vérifie que cette commande appartient bien au magasin ciblé, avant d'agir sur RPOS.
    const proposalOrder = await prisma.proposalOrder.findFirst({
      where: { rposOrderId: req.params.rposOrderId, proposal: { rposShopId: shopId } },
    });
    const legacyProposal = proposalOrder ? null : await prisma.proposal.findFirst({
      where: { rposShopId: shopId, rposOrderId: req.params.rposOrderId },
    });
    if (!proposalOrder && !legacyProposal) {
      return res.status(404).json({ success: false, message: 'Commande introuvable pour ce magasin' });
    }

    await rpos.cancelSupplierOrder(posId, req.params.rposOrderId);

    if (proposalOrder) {
      await prisma.proposalOrder.update({ where: { id: proposalOrder.id }, data: { status: 'CANCELLED' } });
    }

    res.json({ success: true, message: 'Commande annulée sur RPOS' });
  } catch (error) {
    console.error('Cancel order error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal?limit=<n> - proposition de commande du magasin de l'utilisateur
module.exports = router;
