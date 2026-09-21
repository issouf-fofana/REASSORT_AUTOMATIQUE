// Sous-routeur 'shops' — Magasins/serveurs RPOS, commandes fournisseurs, statuts de reception.
// Monte dans routes/reassort/index.js sous le prefixe /api/reassort (requireAuth +
// requireSupervisedShop appliques la-bas, pas ici). Ne jamais monter ailleurs.
const express = require('express');
const router = express.Router();
const { requireAdmin, resolveShopId, resolvePosId, SINGLE_SHOP_ROLES } = require('../../middleware/auth');
const prisma = require('../../utils/prisma');
const rpos = require('../../services/rposClient');
const rposServers = require('../../services/rposServersService');
const { DEPARTMENT_SCOPED_ROLES } = require('../../services/aiPermissionsService');
const { getRevenueAllShops } = require('../../services/chatbotToolsService');

// Un Rayonniste/Chef de département ne voit que les commandes de SON rayon — les commandes RPOS
// sont créées une par rayon (readme §11, ProposalOrder.department) donc chaque commande a un
// périmètre précis. `user.assignedDepartment` peut contenir plusieurs rayons séparés par une
// virgule (comparaison insensible à la casse, même logique que filterProposalLinesForUser).
function isDepartmentAllowedForUser(department, user) {
  if (!user || !DEPARTMENT_SCOPED_ROLES.has(user.role)) return true;
  if (!user.assignedDepartment) return false;
  const allowed = new Set(user.assignedDepartment.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean));
  return !!department && allowed.has(String(department).trim().toLowerCase());
}

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

// PUT /api/reassort/servers/apply-all - applique le même identifiant RPOS à TOUS les serveurs
// (cas Prosuma où un seul compte RPOS est valide sur toutes les plateformes) — ADMIN uniquement.
// body: { rposUser, rposPassword }
// DOIT être déclarée AVANT /servers/:posId ci-dessous : Express matche les routes dans l'ordre
// de déclaration, donc "apply-all" serait sinon capturé par :posId (avec posId="apply-all", qui
// n'existe jamais en base → 500 "Record to update not found").
router.put('/servers/apply-all', requireAdmin, async (req, res) => {
  try {
    const { rposUser, rposPassword } = req.body;
    if (!rposUser && !rposPassword) {
      return res.status(400).json({ success: false, message: 'rposUser ou rposPassword requis' });
    }
    await rposServers.applyCredentialsToAllServers({ rposUser, rposPassword });
    rpos.invalidateRposConfigCache();
    const servers = await rposServers.listServers();
    res.json({ success: true, data: servers.map((s) => ({ posId: s.posId, rposUser: s.rposUser, isActive: s.isActive })) });
  } catch (error) {
    console.error('Apply credentials to all servers error:', error);
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

// GET /api/reassort/shops/default - magasin à présélectionner par défaut pour un compte
// ADMIN/SUPERVISOR qui n'a encore jamais explicitement choisi de magasin sur ce navigateur (demande
// du 21/09/2026 : "on le classe par défaut par le magasin le plus haut niveau" — jusqu'ici, sans
// aucun choix mémorisé en localStorage, chaque page retombait sur le PREMIER magasin par ordre
// alphabétique de code, ex: "313", donnant l'impression que les données affichées étaient
// arbitraires/mélangées). Retourne le magasin au CA le plus élevé sur les 7 derniers jours parmi
// ceux accessibles à l'utilisateur — jamais appelé pour un rôle mono-magasin (son seul magasin est
// déjà connu directement depuis le JWT, pas besoin de ce calcul).
router.get('/shops/default', async (req, res) => {
  try {
    if (SINGLE_SHOP_ROLES.has(req.user.role)) {
      return res.json({ success: true, data: req.user.rposShopId ? { id: req.user.rposShopId } : null });
    }
    if (req.user.role !== 'ADMIN' && req.user.role !== 'SUPERVISOR') {
      return res.status(403).json({ success: false, message: 'Réservé aux administrateurs et superviseurs' });
    }

    const allowedShopIds = req.user.role === 'ADMIN'
      ? (await prisma.shop.findMany({ select: { rposShopId: true } })).map((s) => s.rposShopId)
      : (await prisma.supervisedShop.findMany({ where: { userId: req.user.id }, select: { rposShopId: true } })).map((s) => s.rposShopId);

    if (!allowedShopIds.length) return res.json({ success: true, data: null });

    const result = await getRevenueAllShops(allowedShopIds, { days: 7 });
    const topShop = result.found && result.shops.length ? result.shops[0] : null;
    res.json({ success: true, data: topShop ? { id: topShop.rposShopId } : { id: allowedShopIds[0] } });
  } catch (error) {
    console.error('Default shop error:', error);
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
    // Compte à un seul magasin fixe (DIRECTOR/DEPARTMENT_HEAD/SHELF_STOCKER, ex-STORE) : renvoie
    // directement SON magasin (liste à un seul élément), plutôt qu'un 403 générique. Bug trouvé le
    // 15/09/2026 lors de l'audit de robustesse (test réel via /api/auth/login + appel HTTP) : cette
    // route restait bloquée pour ces rôles malgré la correction côté frontend (qui évite déjà de
    // l'appeler pour eux) — un composant qui l'appellerait quand même (widget IA, sélecteur de
    // magasin sur une page non encore auditée) recevait un 403 au lieu du magasin attendu.
    if (SINGLE_SHOP_ROLES.has(req.user.role)) {
      if (!req.user.rposShopId) {
        return res.json({ success: true, data: [] });
      }
      return res.json({
        success: true,
        data: [{ id: req.user.rposShopId, reference: req.user.rposShopReference, name: req.user.rposShopName, posId: req.user.rposPosId }],
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
// GET /api/reassort/shops/:shopId/rayons - liste des rayons réels (niveau ProposalLine.department)
// d'un magasin, pour le champ "Rayon(s) assigné(s)" de la création/édition d'un compte Rayonniste/
// Chef de département (users-list.html) — remplace un champ texte libre où une faute de frappe
// rendait silencieusement le filtre par département inopérant (aucune ligne ne matcherait jamais le
// nom mal orthographié, cf. filterProposalLinesForUser). Réservé ADMIN : seul rôle qui crée/édite
// des comptes.
router.get('/shops/:shopId/rayons', requireAdmin, async (req, res) => {
  try {
    const shop = await prisma.shop.findUnique({ where: { rposShopId: req.params.shopId } });
    if (!shop) return res.status(404).json({ success: false, message: 'Magasin introuvable' });

    const rayons = await rpos.getShopRayons(shop.rposPosId, shop.rposShopId);
    res.json({ success: true, data: rayons });
  } catch (error) {
    console.error('Shop rayons error:', error);
    res.status(502).json({ success: false, message: error.message });
  }
});

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

    // Un Rayonniste/Chef de département ne doit voir que les commandes de SON rayon — chaque
    // commande RPOS créée par ce système correspond à un rayon précis (ProposalOrder.department),
    // retrouvé ici via son rposOrderId pour filtrer la liste ; une commande créée hors de ce système
    // (donc sans département connu) est masquée par prudence pour un rôle restreint plutôt que
    // montrée par défaut (faille trouvée le 16/09/2026 : /orders retournait TOUTES les commandes du
    // magasin, tous rayons confondus, à n'importe quel rôle).
    let allOrders = [...orders, ...deletedOrders];
    let restrictedTotalAdjustment = 0;
    if (DEPARTMENT_SCOPED_ROLES.has(req.user.role)) {
      const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
      const departmentByOrderId = new Map(proposalOrders.map((o) => [o.rposOrderId, o.department]));
      const before = allOrders.length;
      allOrders = allOrders.filter((o) => isDepartmentAllowedForUser(departmentByOrderId.get(o.id), currentUser));
      restrictedTotalAdjustment = allOrders.length - before;
    }

    res.json({
      success: true,
      data: {
        orders: allOrders,
        count: (data.count || 0) + deletedOrders.length + restrictedTotalAdjustment,
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
      // Une commande créée par ce système appartient à UN rayon précis (ou "Toutes lignes" pour un
      // magasin non scindé) — un Rayonniste/Chef de département ne doit accéder au détail QUE de la
      // commande de son propre rayon, jamais à celle d'un autre en devinant/itérant son rposOrderId
      // (faille trouvée le 16/09/2026, même famille que le filtre déjà en place sur /orders).
      if (DEPARTMENT_SCOPED_ROLES.has(req.user.role)) {
        const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
        if (!isDepartmentAllowedForUser(proposalOrder.department, currentUser)) {
          return res.status(403).json({ success: false, message: 'Cette commande n\'est pas dans votre périmètre.' });
        }
      }
      const isSplit = proposalOrder.department !== 'Toutes lignes';
      const lines = isSplit
        ? proposalOrder.proposal.lines.filter((l) => (l.department || 'Sans rayon') === proposalOrder.department)
        : proposalOrder.proposal.lines;
      return res.json({ success: true, data: { ...proposalOrder.proposal, lines } });
    }

    // Repli : anciennes commandes créées avant l'introduction de ProposalOrder — pas de département
    // connu par commande (magasin entier), donc jamais montrée à un rôle borné à un rayon.
    if (DEPARTMENT_SCOPED_ROLES.has(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Cette commande n\'est pas dans votre périmètre.' });
    }
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
