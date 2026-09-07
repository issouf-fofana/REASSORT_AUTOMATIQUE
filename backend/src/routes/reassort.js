const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const rpos = require('../services/rposClient');
const {
  generateProposal,
  generateAndSaveProposal,
  getPendingProposal,
  startProposalValidation,
  getProposalStatus,
  getConformityRate,
  getStockoutRate,
  getOverstockRate,
  getForecastAccuracy,
  getAdminDashboard,
} = require('../services/proposalService');
const { requireAuth, requireAdmin, resolveShopId, resolvePosId, requireSupervisedShop } = require('../middleware/auth');
const { runNightlyProposalGeneration } = require('../jobs/nightlyProposalJob');
const { runReceptionSync } = require('../jobs/receptionSyncJob');
const { runSalesSync } = require('../jobs/salesSyncJob');
const salesBackfillService = require('../services/salesBackfillService');
const { getConfig, upsertConfig } = require('../services/configService');
const { MODE_DAYS } = require('../services/periodService');
const systemConfig = require('../services/systemConfigService');
const rposServers = require('../services/rposServersService');
const productInsightCache = require('../services/productInsightCacheService');
const productAnalyticsService = require('../services/productAnalyticsService');
const { findSalesFiles } = require('../services/salesFileService');
const aiForecastService = require('../services/aiForecastService');
const cryptoService = require('../services/cryptoService');
const { mapWithConcurrency } = require('../utils/concurrency');
const multer = require('multer');
const path = require('path');
const fsPromises = require('fs/promises');

// Upload en mémoire (fichiers de vente CSV, quelques Mo max) : on valide le nom et le contenu
// avant d'écrire sur disque, jamais un stockage direct sur le dossier surveillé par multer lui-même.
const salesFileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.use(requireAuth);
// Cloisonnement SUPERVISOR : vérifie en base (jamais via le JWT) que le magasin ciblé par la
// requête fait bien partie de son périmètre supervisé (readme §29-30). No-op pour ADMIN/STORE.
router.use(requireSupervisedShop);

// POST /api/reassort/run-nightly-job - déclenche manuellement le job nocturne (ADMIN, pour les tests)
router.post('/run-nightly-job', requireAdmin, async (req, res) => {
  try {
    await runNightlyProposalGeneration();
    res.json({ success: true, message: 'Job de génération nocturne exécuté' });
  } catch (error) {
    console.error('Manual nightly job error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/run-reception-sync - déclenche manuellement la synchronisation des statuts
// de réception RPOS (ADMIN, pour les tests)
router.post('/run-reception-sync', requireAdmin, async (req, res) => {
  try {
    await runReceptionSync();
    res.json({ success: true, message: 'Synchronisation des statuts de réception exécutée' });
  } catch (error) {
    console.error('Manual reception sync error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/run-sales-sync - déclenche manuellement la synchronisation incrémentale des
// ventes de tous les magasins actifs (ADMIN, pour les tests — s'exécute normalement toutes les
// 15 minutes automatiquement).
router.post('/run-sales-sync', requireAdmin, async (req, res) => {
  try {
    await runSalesSync();
    res.json({ success: true, message: 'Synchronisation des ventes exécutée' });
  } catch (error) {
    console.error('Manual sales sync error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/sales-backfill - démarre (ou reprend, si un run existe déjà pour ce magasin
// et cette période exacte) une récupération historique volumineuse de l'historique de vente d'un
// magasin, découpée en tranches persistées avec reprise automatique (ADMIN). Ne bloque pas : le
// travail continue en tâche de fond, répond immédiatement avec le runId pour permettre le suivi
// (GET /sales-backfill/:runId/status). Body: { posId, shopId, days } OU { posId, shopId,
// periodStart, periodEnd } pour choisir un intervalle de dates précis plutôt qu'un simple nombre
// de jours glissants depuis aujourd'hui.
router.post('/sales-backfill', requireAdmin, async (req, res) => {
  try {
    const { posId, shopId, days, periodStart: bodyStart, periodEnd: bodyEnd } = req.body;
    if (!posId || !shopId) {
      return res.status(400).json({ success: false, message: 'posId et shopId requis' });
    }
    const now = new Date();
    const periodEnd = bodyEnd ? new Date(bodyEnd) : now;
    const periodStart = bodyStart ? new Date(bodyStart) : new Date(now.getTime() - (days || 90) * 24 * 60 * 60 * 1000);
    if (periodStart >= periodEnd) {
      return res.status(400).json({ success: false, message: 'La date de début doit être antérieure à la date de fin' });
    }
    const runId = await salesBackfillService.startBackfill(posId, shopId, periodStart.toISOString(), periodEnd.toISOString());
    res.json({ success: true, message: 'Récupération démarrée', data: { runId } });
  } catch (error) {
    console.error('Sales backfill error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/sales-backfill/:runId/status - progression détaillée d'un run (ADMIN), pour
// affichage en temps réel (polling côté UI) : total attendu/récupéré, % d'avancement, détail par
// tranche (terminée / en cours / en attente / erreur).
router.get('/sales-backfill/:runId/status', requireAdmin, async (req, res) => {
  try {
    const status = await salesBackfillService.getRunStatus(req.params.runId);
    if (!status) return res.status(404).json({ success: false, message: 'Run introuvable' });
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/sales-backfill/active?shopId=... - trouve un run interrompu ou en cours pour
// ce magasin (ADMIN), pour proposer une reprise dès l'ouverture de la page plutôt que de laisser
// l'utilisateur relancer manuellement et redécouvrir la persistance par hasard.
router.get('/sales-backfill/active', requireAdmin, async (req, res) => {
  try {
    const { shopId } = req.query;
    if (!shopId) return res.status(400).json({ success: false, message: 'shopId requis' });
    const run = await salesBackfillService.findResumableRun(shopId);
    res.json({ success: true, data: run });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/sales-backfill/:runId/resume - relance le traitement d'un run existant
// (ADMIN) : reprend les tranches non terminées là où elles se sont arrêtées, sans retélécharger
// les tranches déjà DONE ni dupliquer les lignes déjà insérées d'une tranche partiellement faite.
router.post('/sales-backfill/:runId/resume', requireAdmin, async (req, res) => {
  try {
    salesBackfillService.processRun(req.params.runId).catch((err) => console.error('Resume backfill error:', err.message));
    res.json({ success: true, message: 'Reprise démarrée' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/sales-backfill/:runId/pause - demande l'arrêt propre d'un run en cours
// (ADMIN) : la progression déjà persistée (pages et tranches terminées) est conservée, le run passe
// à PAUSED dès que le traitement en cours atteint son prochain point de contrôle (entre deux pages
// RPOS, quelques secondes), et peut être repris plus tard via /resume sans rien perdre.
router.post('/sales-backfill/:runId/pause', requireAdmin, async (req, res) => {
  try {
    await salesBackfillService.requestPause(req.params.runId);
    res.json({ success: true, message: 'Pause demandée, en cours d\'arrêt...' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/sales-backfill/:runId/cancel - annule définitivement un run bloqué
// (PAUSED ou ERROR, ex: coupure réseau pendant la récupération) : les lignes déjà récupérées
// restent en base, seul le run est clos pour ne plus être proposé en reprise. Un run IN_PROGRESS
// doit d'abord être mis en pause (/pause) avant de pouvoir être annulé.
router.post('/sales-backfill/:runId/cancel', requireAdmin, async (req, res) => {
  try {
    await salesBackfillService.cancelRun(req.params.runId);
    res.json({ success: true, message: 'Récupération annulée. Les ventes déjà récupérées restent disponibles.' });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/sales-lines - consultation paginée des ventes synchronisées localement pour
// un magasin (ADMIN), avec filtres période/article, pour vérifier ce qui a réellement été récupéré
// sans repasser par RPOS. Query: shopId (requis), dateStart, dateEnd, ean, page, pageSize.
router.get('/sales-lines', requireAdmin, async (req, res) => {
  try {
    const { shopId, dateStart, dateEnd, ean, page, pageSize } = req.query;
    if (!shopId) return res.status(400).json({ success: false, message: 'shopId requis' });

    const where = { rposShopId: shopId };
    if (dateStart || dateEnd) {
      where.date = {};
      if (dateStart) where.date.gte = new Date(dateStart);
      if (dateEnd) where.date.lte = new Date(dateEnd);
    }
    if (ean) where.ean = ean;

    const take = Math.min(parseInt(pageSize, 10) || 100, 500);
    const skip = ((parseInt(page, 10) || 1) - 1) * take;

    const [total, lines, aggregate] = await Promise.all([
      prisma.salesLine.count({ where }),
      prisma.salesLine.findMany({ where, orderBy: { date: 'desc' }, take, skip }),
      prisma.salesLine.aggregate({ where, _sum: { quantity: true, revenueExclTax: true } }),
    ]);

    res.json({
      success: true,
      data: {
        total,
        page: parseInt(page, 10) || 1,
        pageSize: take,
        totalQuantity: aggregate._sum.quantity || 0,
        totalRevenue: aggregate._sum.revenueExclTax || 0,
        lines,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/reassort/sales-lines - purge les ventes synchronisées localement pour un magasin sur
// une période donnée (ADMIN). Action irréversible : n'efface que la copie locale (SalesLine), pas
// les ventes réelles côté RPOS — une resynchronisation (Paramètres → Synchronisation des ventes)
// permet de les récupérer à nouveau si besoin. Query: shopId (requis), dateStart, dateEnd (requis
// tous les deux pour éviter une purge accidentelle de tout l'historique du magasin).
router.delete('/sales-lines', requireAdmin, async (req, res) => {
  try {
    const { shopId, dateStart, dateEnd } = req.query;
    if (!shopId) return res.status(400).json({ success: false, message: 'shopId requis' });
    if (!dateStart || !dateEnd) {
      return res.status(400).json({ success: false, message: 'dateStart et dateEnd requis (purge totale non autorisée par sécurité)' });
    }

    const result = await prisma.salesLine.deleteMany({
      where: { rposShopId: shopId, date: { gte: new Date(dateStart), lte: new Date(dateEnd) } },
    });

    res.json({ success: true, message: `${result.count} ligne(s) supprimée(s)`, data: { count: result.count } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/sales-lines/coverage - pour un magasin, la plus ancienne et la plus récente
// date de vente synchronisée localement (ADMIN), pour visualiser d'un coup d'œil quelle période
// est déjà couverte avant de lancer un nouveau backfill sur une autre période.
router.get('/sales-lines/coverage', requireAdmin, async (req, res) => {
  try {
    const { shopId } = req.query;
    if (!shopId) return res.status(400).json({ success: false, message: 'shopId requis' });

    const [oldest, newest, count] = await Promise.all([
      prisma.salesLine.findFirst({ where: { rposShopId: shopId }, orderBy: { date: 'asc' }, select: { date: true } }),
      prisma.salesLine.findFirst({ where: { rposShopId: shopId }, orderBy: { date: 'desc' }, select: { date: true } }),
      prisma.salesLine.count({ where: { rposShopId: shopId } }),
    ]);

    res.json({ success: true, data: { oldestDate: oldest?.date || null, newestDate: newest?.date || null, count } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/servers - liste tous les serveurs RPOS connus, avec leurs magasins et statut
// (ADMIN uniquement).
//
// Par défaut (sans ?refresh=true), les magasins de chaque serveur sont lus depuis la table locale
// Shop (synchronisée automatiquement toutes les heures par shopsSyncJob.js) plutôt qu'interrogés
// en direct sur RPOS : cette route touchait auparavant les 18 serveurs à CHAQUE ouverture de page,
// ce qui la rendait très lente (et bloquante) dès que le réseau/VPN vers RPOS est instable — alors
// que la liste des magasins change très rarement (cf. shopsSyncJob.js). Passez ?refresh=true pour
// forcer un appel RPOS direct (ex: bouton "Actualiser depuis RPOS" côté UI), utile juste après
// l'ajout d'un nouveau magasin qui n'a pas encore été synchronisé.
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
router.get('/proposal', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;

    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    const shopReference = req.user.rposShopReference || req.query.shopReference;
    const result = await generateProposal(posId, shopId, limit, shopReference);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Proposal generation error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/create-order - transmet une commande ad hoc vers RPOS (mode manuel, hors historisation)
// body: { supplierId, externalReference, comment, lines: [{ productId, quantity }] }
router.post('/create-order', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    const { supplierId, orderDate, deliveryDate, externalReference, comment, lines } = req.body;

    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    if (!supplierId || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ success: false, message: 'supplierId et lines sont requis' });
    }

    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const order = await rpos.createSupplierOrder(posId, {
      shopId,
      supplierId,
      date: orderDate || now.toISOString().slice(0, 19),
      deliveryDate: deliveryDate || tomorrow.toISOString().slice(0, 10),
      externalReference: externalReference || 'Proposition réassort IA',
      comment: comment || `Commande générée automatiquement par le système de réassort (${req.user.name})`,
    });

    // Envoi des lignes par lots parallèles plutôt qu'une par une (audit performance : bloquait la
    // réponse HTTP plusieurs minutes sur une grosse commande) — concurrence modérée pour rester
    // raisonnable sur les écritures concurrentes d'une même commande fournisseur côté RPOS.
    const createdLines = [];
    const failedLines = [];
    const LINE_CONCURRENCY = 5;
    await mapWithConcurrency(lines, LINE_CONCURRENCY, async (line) => {
      try {
        const created = await rpos.addSupplierOrderLine(posId, {
          orderId: order.id,
          productId: line.productId,
          quantity: line.quantity,
          orderingUnit: line.orderingUnit,
        });
        createdLines.push(created);
      } catch (err) {
        failedLines.push({ productId: line.productId, error: err.body || err.message });
      }
    });

    res.status(201).json({
      success: true,
      data: {
        order,
        linesCreated: createdLines.length,
        linesFailed: failedLines.length,
        failedLines,
      },
    });
  } catch (error) {
    console.error('Create order error:', error);
    res.status(502).json({ success: false, message: error.message, details: error.body });
  }
});

// --- Flux historisé (phase pilote) ---

// POST /api/reassort/proposal/generate?limit=<n> - génère et sauvegarde une proposition, à la
// demande. Ouvert aux comptes STORE (pour leur propre magasin) et ADMIN (avec ?shop=&pos=).
// Rejette l'ancienne proposition GENERATED du magasin si elle n'a pas encore été validée.
router.post('/proposal/generate', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    const limit = req.body.limit ? parseInt(req.body.limit, 10) : undefined;

    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    const shopReference = req.user.rposShopReference || req.body.shopReference;
    const shopName = req.user.rposShopName || req.body.shopName;

    if (!shopReference || !shopName) {
      return res.status(400).json({ success: false, message: 'Référence et nom du magasin requis (shopReference, shopName)' });
    }

    // Override ponctuel de la période d'analyse pour cette seule génération (n'affecte jamais la
    // configuration permanente du magasin) : { periodMode, customStart, customEnd }.
    const periodOverride = req.body.periodOverride || undefined;

    const { proposal, stats } = await generateAndSaveProposal({ posId, shopId, shopReference, shopName, limit, periodOverride });
    res.status(201).json({ success: true, data: { proposal, stats } });
  } catch (error) {
    console.error('Proposal generate+save error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal/pending - la proposition du jour en attente de validation pour le magasin de l'utilisateur
router.get('/proposal/pending', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    const proposal = await getPendingProposal(shopId);
    res.json({ success: true, data: proposal });
  } catch (error) {
    console.error('Pending proposal error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/proposal/:id/validate - démarre la validation (envoi vers RPOS en tâche de fond)
// body: { supplierId, externalReference, comment, orderDate, deliveryDate, decisions: [{ lineId, quantity, excluded }],
//         validateAfterCreate }
// validateAfterCreate=false (par défaut) : la commande reste "en préparation" sur RPOS, non prise en
// compte par l'entrepôt (utile en phase de test). true : la commande est en plus validée sur RPOS.
// Répond immédiatement avec status "VALIDATING" ; suivre la progression via GET .../status
router.post('/proposal/:id/validate', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    const { supplierId, orderDate, deliveryDate, externalReference, comment, decisions, validateAfterCreate } = req.body;

    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    if (!supplierId || !Array.isArray(decisions)) {
      return res.status(400).json({ success: false, message: 'supplierId et decisions sont requis' });
    }

    const result = await startProposalValidation({
      proposalId: req.params.id,
      posId,
      shopId,
      userEmail: req.user.email,
      decisions,
      orderHeader: { supplierId, orderDate, deliveryDate, externalReference, comment },
      validateAfterCreate: !!validateAfterCreate,
    });

    res.status(202).json({ success: true, data: result });
  } catch (error) {
    console.error('Start validation error:', error);
    res.status(400).json({ success: false, message: error.message, details: error.body });
  }
});

// GET /api/reassort/proposal/:id/status - progression de l'envoi vers RPOS
router.get('/proposal/:id/status', async (req, res) => {
  try {
    const status = await getProposalStatus(req.params.id);
    if (!status) return res.status(404).json({ success: false, message: 'Proposition introuvable' });
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/conformity - taux de conformité (propositions validées sans modification)
router.get('/conformity', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const result = await getConformityRate(shopId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/stockout-rate - taux de rupture (articles déjà en rupture au moment de la
// génération, sur les propositions validées)
router.get('/stockout-rate', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const result = await getStockoutRate(shopId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/overstock-rate - taux de surstock (quantité commandée bien au-delà du besoin
// théorique, sur les propositions validées)
router.get('/overstock-rate', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const result = await getOverstockRate(shopId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/forecast-accuracy - précision des prévisions (quantité prévue vs réellement
// vendue, sur les lignes validées dont la fenêtre de mesure est écoulée)
router.get('/forecast-accuracy', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const result = await getForecastAccuracy(shopId);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Forecast accuracy error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/admin/dashboard - vue globale multi-magasins (ADMIN uniquement, readme §32)
router.get('/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const result = await getAdminDashboard();
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Admin dashboard error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/product/:productId/last-purchase?ean=<ean> - dernier achat (commande fournisseur)
// et dernière vente enregistrée pour un article (date + quantité de chaque).
router.get('/product/:productId/last-purchase', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const data = await productInsightCache.getProductInsight(posId, shopId, req.params.productId, req.query.ean);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Last-purchase/last-sale error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/product/:productId/analytics?ean=&dateStart=&dateEnd= - évolution d'un article
// sur une période choisie : courbe de ventes (granularité adaptée à la durée), historique de
// commandes, indicateurs de comportement (tendance, fréquence de commande), et prédiction de la
// prochaine commande.
router.get('/product/:productId/analytics', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const { ean, dateStart, dateEnd } = req.query;
    if (!ean || !dateStart || !dateEnd) {
      return res.status(400).json({ success: false, message: 'ean, dateStart et dateEnd sont requis' });
    }

    const config = await getConfig(shopId);
    let currentStock;
    let currentOrderedQuantity;
    try {
      const product = await rpos.getProductByEan(posId, shopId, ean);
      if (product) {
        currentStock = Number(product.stock || 0);
        currentOrderedQuantity = Number(product.current_ordered_quantity || 0);
      }
    } catch (err) {
      console.error('[product analytics] Échec de lecture du produit RPOS:', err.message);
    }

    const data = await productAnalyticsService.analyzeProduct(posId, shopId, {
      ean,
      productId: req.params.productId,
      dateStart,
      dateEnd,
      safetyStockRatio: config.safetyStockRatio,
      currentStock,
      currentOrderedQuantity,
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Product analytics error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/config - configuration réassort du magasin de l'utilisateur (seuil Pareto, période, etc.)
router.get('/config', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const config = await getConfig(shopId);
    res.json({ success: true, data: { ...config, availablePeriodModes: Object.keys(MODE_DAYS).concat('CUSTOM') } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/reassort/config - met à jour la configuration réassort du magasin
// body: { paretoThreshold, safetyStockRatio, periodMode, customStart, customEnd,
//         treatNegativeStockAsZero, revenueSharePeriodDays, overstockThresholdMultiplier, splitOrdersByDepartment, forecastAccuracyWindowDays, forecastAccuracyThresholdPct, seasonalityComparisonEnabled, seasonalityLookbackYears, seasonalityAdjustmentThresholdPct, receptionLeadTimeDays, useReceptionLeadTimeInCalculation, excludeGenericArticlesBelowPrice }
router.put('/config', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    const {
      paretoThreshold, safetyStockRatio, periodMode, customStart, customEnd,
      treatNegativeStockAsZero, revenueSharePeriodDays, overstockThresholdMultiplier, splitOrdersByDepartment, forecastAccuracyWindowDays, forecastAccuracyThresholdPct, seasonalityComparisonEnabled, seasonalityLookbackYears, seasonalityAdjustmentThresholdPct, receptionLeadTimeDays, useReceptionLeadTimeInCalculation, excludeGenericArticlesBelowPrice, recentOrderMaxAgeDays, forecastEnabled, forecastAlpha,
    } = req.body;
    const data = {};
    if (paretoThreshold !== undefined) data.paretoThreshold = paretoThreshold;
    if (safetyStockRatio !== undefined) data.safetyStockRatio = safetyStockRatio;
    if (periodMode !== undefined) data.periodMode = periodMode;
    if (customStart !== undefined) data.customStart = customStart ? new Date(customStart) : null;
    if (customEnd !== undefined) data.customEnd = customEnd ? new Date(customEnd) : null;
    if (treatNegativeStockAsZero !== undefined) data.treatNegativeStockAsZero = treatNegativeStockAsZero;
    if (revenueSharePeriodDays !== undefined) data.revenueSharePeriodDays = revenueSharePeriodDays;
    if (overstockThresholdMultiplier !== undefined) data.overstockThresholdMultiplier = overstockThresholdMultiplier;
    if (splitOrdersByDepartment !== undefined) data.splitOrdersByDepartment = splitOrdersByDepartment;
    if (forecastAccuracyWindowDays !== undefined) data.forecastAccuracyWindowDays = forecastAccuracyWindowDays;
    if (forecastAccuracyThresholdPct !== undefined) data.forecastAccuracyThresholdPct = forecastAccuracyThresholdPct;
    if (seasonalityComparisonEnabled !== undefined) data.seasonalityComparisonEnabled = seasonalityComparisonEnabled;
    if (seasonalityLookbackYears !== undefined) data.seasonalityLookbackYears = seasonalityLookbackYears;
    if (seasonalityAdjustmentThresholdPct !== undefined) data.seasonalityAdjustmentThresholdPct = seasonalityAdjustmentThresholdPct;
    if (receptionLeadTimeDays !== undefined) data.receptionLeadTimeDays = receptionLeadTimeDays;
    if (useReceptionLeadTimeInCalculation !== undefined) data.useReceptionLeadTimeInCalculation = useReceptionLeadTimeInCalculation;
    if (excludeGenericArticlesBelowPrice !== undefined) data.excludeGenericArticlesBelowPrice = excludeGenericArticlesBelowPrice;
    if (recentOrderMaxAgeDays !== undefined) data.recentOrderMaxAgeDays = recentOrderMaxAgeDays;
    if (forecastEnabled !== undefined) data.forecastEnabled = forecastEnabled;
    if (forecastAlpha !== undefined) data.forecastAlpha = forecastAlpha;

    const config = await upsertConfig(shopId, data, req.user.email);
    res.json({ success: true, data: config });
  } catch (error) {
    console.error('Update config error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/reassort/config/bulk - applique les mêmes paramètres à plusieurs magasins (ADMIN uniquement)
// body: { shopIds: [uuid, ...], paretoThreshold, safetyStockRatio, periodMode, customStart, customEnd,
//         treatNegativeStockAsZero, revenueSharePeriodDays, overstockThresholdMultiplier, splitOrdersByDepartment, forecastAccuracyWindowDays, forecastAccuracyThresholdPct, seasonalityComparisonEnabled, seasonalityLookbackYears, seasonalityAdjustmentThresholdPct, receptionLeadTimeDays, useReceptionLeadTimeInCalculation, excludeGenericArticlesBelowPrice }
router.put('/config/bulk', async (req, res) => {
  try {
    if (req.user.role === 'STORE') {
      return res.status(403).json({ success: false, message: 'Réservé aux administrateurs et superviseurs' });
    }

    const {
      shopIds, paretoThreshold, safetyStockRatio, periodMode, customStart, customEnd,
      treatNegativeStockAsZero, revenueSharePeriodDays, overstockThresholdMultiplier, splitOrdersByDepartment, forecastAccuracyWindowDays, forecastAccuracyThresholdPct, seasonalityComparisonEnabled, seasonalityLookbackYears, seasonalityAdjustmentThresholdPct, receptionLeadTimeDays, useReceptionLeadTimeInCalculation, excludeGenericArticlesBelowPrice, recentOrderMaxAgeDays, forecastEnabled, forecastAlpha,
    } = req.body;
    if (!Array.isArray(shopIds) || shopIds.length === 0) {
      return res.status(400).json({ success: false, message: 'shopIds (tableau non vide) est requis' });
    }

    if (req.user.role === 'SUPERVISOR') {
      // Un superviseur ne peut appliquer une config en masse qu'à des magasins de son périmètre.
      const supervised = await prisma.supervisedShop.findMany({
        where: { userId: req.user.id, rposShopId: { in: shopIds } },
      });
      if (supervised.length !== shopIds.length) {
        return res.status(403).json({ success: false, message: 'Un ou plusieurs magasins ne sont pas dans votre périmètre de supervision' });
      }
    }

    const data = {};
    if (paretoThreshold !== undefined) data.paretoThreshold = paretoThreshold;
    if (safetyStockRatio !== undefined) data.safetyStockRatio = safetyStockRatio;
    if (periodMode !== undefined) data.periodMode = periodMode;
    if (customStart !== undefined) data.customStart = customStart ? new Date(customStart) : null;
    if (customEnd !== undefined) data.customEnd = customEnd ? new Date(customEnd) : null;
    if (treatNegativeStockAsZero !== undefined) data.treatNegativeStockAsZero = treatNegativeStockAsZero;
    if (revenueSharePeriodDays !== undefined) data.revenueSharePeriodDays = revenueSharePeriodDays;
    if (overstockThresholdMultiplier !== undefined) data.overstockThresholdMultiplier = overstockThresholdMultiplier;
    if (splitOrdersByDepartment !== undefined) data.splitOrdersByDepartment = splitOrdersByDepartment;
    if (forecastAccuracyWindowDays !== undefined) data.forecastAccuracyWindowDays = forecastAccuracyWindowDays;
    if (forecastAccuracyThresholdPct !== undefined) data.forecastAccuracyThresholdPct = forecastAccuracyThresholdPct;
    if (seasonalityComparisonEnabled !== undefined) data.seasonalityComparisonEnabled = seasonalityComparisonEnabled;
    if (seasonalityLookbackYears !== undefined) data.seasonalityLookbackYears = seasonalityLookbackYears;
    if (seasonalityAdjustmentThresholdPct !== undefined) data.seasonalityAdjustmentThresholdPct = seasonalityAdjustmentThresholdPct;
    if (receptionLeadTimeDays !== undefined) data.receptionLeadTimeDays = receptionLeadTimeDays;
    if (useReceptionLeadTimeInCalculation !== undefined) data.useReceptionLeadTimeInCalculation = useReceptionLeadTimeInCalculation;
    if (excludeGenericArticlesBelowPrice !== undefined) data.excludeGenericArticlesBelowPrice = excludeGenericArticlesBelowPrice;
    if (recentOrderMaxAgeDays !== undefined) data.recentOrderMaxAgeDays = recentOrderMaxAgeDays;
    if (forecastEnabled !== undefined) data.forecastEnabled = forecastEnabled;
    if (forecastAlpha !== undefined) data.forecastAlpha = forecastAlpha;

    const results = [];
    for (const shopId of shopIds) {
      const config = await upsertConfig(shopId, data, req.user.email);
      results.push(config);
    }

    res.json({ success: true, data: { updated: results.length, configs: results } });
  } catch (error) {
    console.error('Bulk update config error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/system-config - configuration globale (ADMIN uniquement)
router.get('/system-config', requireAdmin, async (req, res) => {
  try {
    const config = await systemConfig.getAll();
    res.json({ success: true, data: config });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/reassort/system-config - met à jour une clé de configuration globale (ADMIN uniquement)
// body: { key, value }
router.put('/system-config', requireAdmin, async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || value === undefined) {
      return res.status(400).json({ success: false, message: 'key et value sont requis' });
    }
    if (!Object.values(systemConfig.KEYS).includes(key)) {
      return res.status(400).json({ success: false, message: 'Clé de configuration inconnue' });
    }

    if ([systemConfig.KEYS.NIGHTLY_PROPOSAL_CRON, systemConfig.KEYS.RECEPTION_SYNC_CRON].includes(key)) {
      const cron = require('node-cron');
      if (!cron.validate(value)) {
        return res.status(400).json({ success: false, message: 'Expression cron invalide' });
      }
    }

    if (key === systemConfig.KEYS.JWT_EXPIRES_IN && !/^\d+\s*(s|m|h|d)$/.test(value.trim())) {
      return res.status(400).json({ success: false, message: 'Durée invalide (format attendu : ex. "30m", "12h", "7d")' });
    }

    if (key === systemConfig.KEYS.LAST_SALE_SEARCH_WINDOWS_DAYS) {
      const windows = value.split(',').map((s) => s.trim());
      if (!windows.length || windows.some((w) => !/^\d+$/.test(w) || parseInt(w, 10) <= 0)) {
        return res.status(400).json({ success: false, message: 'Liste invalide : entiers positifs séparés par des virgules (ex: 31,93,366)' });
      }
    }

    await systemConfig.setValue(key, value);

    // Certains changements doivent prendre effet immédiatement, pas seulement au prochain
    // rafraîchissement de cache ou redémarrage.
    if ([systemConfig.KEYS.RPOS_RETRY_ATTEMPTS, systemConfig.KEYS.RPOS_RETRY_DELAY_MS].includes(key)) {
      rpos.invalidateRposConfigCache();
    }
    if (key === systemConfig.KEYS.NIGHTLY_PROPOSAL_CRON) {
      const { startOrRestartNightlyJob } = require('../jobs/cronManager');
      await startOrRestartNightlyJob();
    }
    if (key === systemConfig.KEYS.RECEPTION_SYNC_CRON) {
      const { startOrRestartReceptionSyncJob } = require('../jobs/cronManager');
      await startOrRestartReceptionSyncJob();
    }

    res.json({ success: true, data: { key, value: systemConfig.SENSITIVE_KEYS.has(key) ? '••••••••' : value } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/system-config/sales-files-check?shop=<reference> - vérifie l'accès au dossier
// et liste les fichiers trouvés pour un code magasin (utile pour valider la config depuis l'UI)
router.get('/system-config/sales-files-check', requireAdmin, async (req, res) => {
  try {
    const shopReference = req.query.shopReference;
    const baseDir = await systemConfig.getValue(systemConfig.KEYS.SALES_FILES_DIR);
    const fs = require('fs');
    const dirAccessible = fs.existsSync(baseDir);
    const files = dirAccessible && shopReference ? findSalesFiles(baseDir, shopReference) : [];
    res.json({ success: true, data: { baseDir, dirAccessible, files } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/system-config/sales-files-upload - dépose un fichier d'export de ventes CSV
// directement dans le dossier surveillé, sans avoir besoin d'un accès manuel au partage réseau
// (ex: import d'un historique ancien fourni par un collègue, hors du flux FTP automatique habituel).
// Nom de fichier strictement validé (même format que findSalesFiles) pour ne jamais écrire en
// dehors du dossier configuré ni accepter un fichier qui ne serait pas détecté ensuite.
const SALES_FILE_NAME_PATTERN = /^[a-zA-Z0-9]+_statvente-lignes_articles_[a-zA-Z0-9_-]+\.csv$/i;

router.post('/system-config/sales-files-upload', requireAdmin, salesFileUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'Aucun fichier reçu' });
    }
    const originalName = req.file.originalname;
    if (!SALES_FILE_NAME_PATTERN.test(originalName)) {
      return res.status(400).json({
        success: false,
        message: `Nom de fichier invalide : "${originalName}". Format attendu : <code_magasin>_statvente-lignes_articles_<date>.csv (ex: 050_statvente-lignes_articles_01062024_0000.csv)`,
      });
    }

    const baseDir = await systemConfig.getValue(systemConfig.KEYS.SALES_FILES_DIR);
    if (!require('fs').existsSync(baseDir)) {
      return res.status(400).json({ success: false, message: `Le dossier configuré "${baseDir}" n'existe pas ou n'est pas accessible.` });
    }

    // path.basename() défend contre un nom de fichier contenant des séparateurs de chemin
    // (../, /) malgré la validation par regex ci-dessus — ceinture et bretelles sur un chemin
    // d'écriture disque construit à partir d'une entrée utilisateur.
    const safeName = path.basename(originalName);
    const destPath = path.join(baseDir, safeName);
    await fsPromises.writeFile(destPath, req.file.buffer);

    res.json({ success: true, message: `Fichier "${safeName}" importé avec succès dans ${baseDir}.` });
  } catch (error) {
    console.error('Sales file upload error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- IA (LLM) : gestion des clés API multi-fournisseurs et prévision à la demande ---

// GET /api/reassort/ai/keys - liste les clés configurées (ADMIN uniquement), sans jamais renvoyer
// la clé en clair : seul un aperçu masqué (4 derniers caractères) est exposé.
router.get('/ai/keys', requireAdmin, async (req, res) => {
  try {
    const keys = await prisma.aiProviderKey.findMany({ orderBy: { priority: 'asc' } });
    const data = keys.map((k) => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      model: k.model,
      priority: k.priority,
      isActive: k.isActive,
      lastUsedAt: k.lastUsedAt,
      lastError: k.lastError,
      lastErrorAt: k.lastErrorAt,
      maskedKey: cryptoService.maskApiKey(cryptoService.decrypt(k.encryptedApiKey)),
    }));
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/ai/keys - ajoute une clé API (ADMIN uniquement)
// body: { provider, label, apiKey, model, priority }
router.post('/ai/keys', requireAdmin, async (req, res) => {
  try {
    const { provider, label, apiKey, model, priority } = req.body;
    if (!provider || !label || !apiKey) {
      return res.status(400).json({ success: false, message: 'provider, label et apiKey sont requis' });
    }
    const key = await prisma.aiProviderKey.create({
      data: {
        provider,
        label,
        model: model || null,
        priority: priority ?? 0,
        encryptedApiKey: cryptoService.encrypt(apiKey),
        createdBy: req.user.email,
      },
    });
    res.json({ success: true, data: { id: key.id } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/reassort/ai/keys/:id - met à jour une clé (label, priorité, actif, éventuellement la clé elle-même)
router.put('/ai/keys/:id', requireAdmin, async (req, res) => {
  try {
    const { label, apiKey, model, priority, isActive } = req.body;
    const data = {};
    if (label !== undefined) data.label = label;
    if (model !== undefined) data.model = model || null;
    if (priority !== undefined) data.priority = priority;
    if (isActive !== undefined) data.isActive = isActive;
    if (apiKey) data.encryptedApiKey = cryptoService.encrypt(apiKey);

    await prisma.aiProviderKey.update({ where: { id: req.params.id }, data });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/reassort/ai/keys/:id
router.delete('/ai/keys/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.aiProviderKey.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/ai/keys/:id/test - teste une clé isolément (prompt minimal), sans proposition
router.post('/ai/keys/:id/test', requireAdmin, async (req, res) => {
  try {
    const result = await aiForecastService.testProviderKey(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/proposal/:proposalId/ai-forecast - lance une analyse IA à la demande sur une
// proposition existante (ne modifie jamais la proposition classique).
router.post('/proposal/:proposalId/ai-forecast', requireAdmin, async (req, res) => {
  try {
    const run = await aiForecastService.runAiForecast(req.params.proposalId, req.user.email);
    res.json({ success: true, data: run });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal/:proposalId/ai-forecast - dernier résultat d'analyse IA pour cette proposition
router.get('/proposal/:proposalId/ai-forecast', requireAdmin, async (req, res) => {
  try {
    const run = await aiForecastService.getLatestAiForecast(req.params.proposalId);
    res.json({ success: true, data: run });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
