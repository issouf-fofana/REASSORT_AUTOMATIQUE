const express = require('express');
const router = express.Router();
const prisma = require('../utils/prisma');
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
  getProductByEanCached,
} = require('../services/proposalService');
const { requireAuth, requireAdmin, resolveShopId, resolvePosId, requireSupervisedShop } = require('../middleware/auth');
const shopActivityService = require('../services/shopActivityService');
const chatbotService = require('../services/chatbotService');
const { runNightlyProposalGeneration } = require('../jobs/nightlyProposalJob');
const { runReceptionSync } = require('../jobs/receptionSyncJob');
const { getWeeklyPlanHistory, findWeeklyPlanForDate } = require('../services/weeklyPlanService');
const { runSalesSync } = require('../jobs/salesSyncJob');
const salesBackfillService = require('../services/salesBackfillService');
const { getConfig, upsertConfig } = require('../services/configService');
const { MODE_DAYS, resolvePeriod } = require('../services/periodService');
const systemConfig = require('../services/systemConfigService');
const rposServers = require('../services/rposServersService');
const productInsightCache = require('../services/productInsightCacheService');
const productAnalyticsService = require('../services/productAnalyticsService');
const { findSalesFiles } = require('../services/salesFileService');
const aiForecastService = require('../services/aiForecastService');
const cryptoService = require('../services/cryptoService');
const { mapWithConcurrency } = require('../utils/concurrency');
const jobHealthService = require('../services/jobHealthService');
const improvementService = require('../services/improvementService');
const errorReportService = require('../services/errorReportService');
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

// POST /api/reassort/run-daily-review - déclenche manuellement le réajustement quotidien des
// plans hebdomadaires (ADMIN, pour les tests). CAHIER_DES_CHARGES.md §15-16, étape 3.
router.post('/run-daily-review', requireAdmin, async (req, res) => {
  try {
    const { runDailyReplenishmentReview } = require('../jobs/dailyReplenishmentReviewJob');
    const result = await runDailyReplenishmentReview();
    res.json({ success: true, message: 'Réajustement quotidien exécuté', data: result });
  } catch (error) {
    console.error('Manual daily review error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/run-prediction-outcome - déclenche manuellement l'évaluation des prédictions
// dont la période cible est terminée (ADMIN, pour les tests). CAHIER_DES_CHARGES.md §22, étape 5.
router.post('/run-prediction-outcome', requireAdmin, async (req, res) => {
  try {
    const { runPredictionOutcomeEvaluation } = require('../jobs/predictionOutcomeJob');
    const result = await runPredictionOutcomeEvaluation();
    res.json({ success: true, message: 'Évaluation des prédictions exécutée', data: result });
  } catch (error) {
    console.error('Manual prediction outcome error:', error);
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
      prisma.salesLine.aggregate({ where, _sum: { quantity: true, revenueExclTax: true, revenueInclTax: true } }),
    ]);

    res.json({
      success: true,
      data: {
        total,
        page: parseInt(page, 10) || 1,
        pageSize: take,
        totalQuantity: aggregate._sum.quantity || 0,
        totalRevenue: aggregate._sum.revenueExclTax || 0,
        // null si aucune ligne de la sélection n'a de TTC connu (lignes synchronisées avant
        // l'ajout de ce champ) — distingué de 0 pour ne pas afficher un total TTC faux.
        totalRevenueInclTax: aggregate._sum.revenueInclTax,
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

// GET /api/reassort/sales-lines/departments - résout le rayon (department) de chaque EAN fourni,
// pour regrouper l'affichage de "Ventes synchronisées" par rayon (ADMIN) comme sur les pages
// Historique des commandes et IA & Prédictions. SalesLine ne stocke que l'EAN (une ligne de vente
// individuelle, pas un article catalogué) : le rayon n'existe qu'au niveau du produit RPOS, donc on
// le résout via ProductCache (déjà alimenté par toute génération de proposition passée sur ce
// magasin, cache-aside persistant) + un appel RPOS de repli pour les EAN encore inconnus.
// Query: shopId, posId, eans (CSV). Réponse: { [ean]: { sector, department } }.
router.get('/sales-lines/departments', requireAdmin, async (req, res) => {
  try {
    const { shopId, posId, eans } = req.query;
    if (!shopId || !posId || !eans) return res.status(400).json({ success: false, message: 'shopId, posId et eans sont requis' });

    const eanList = [...new Set(eans.split(',').map((e) => e.trim()).filter(Boolean))];
    const byEan = {};
    const EAN_CONCURRENCY = 8;

    await mapWithConcurrency(eanList, EAN_CONCURRENCY, async (ean) => {
      try {
        const product = await getProductByEanCached(posId, shopId, ean);
        if (!product) { byEan[ean] = { sector: 'Article introuvable', department: 'Article introuvable' }; return; }
        const { sector, rayon } = await rpos.getDepartmentHierarchy(posId, product.department?.id);
        byEan[ean] = { sector, department: rayon };
      } catch (err) {
        byEan[ean] = { sector: 'Erreur', department: 'Erreur' };
      }
    });

    res.json({ success: true, data: byEan });
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

// GET /api/reassort/sales-lines/rpos-earliest-available - interroge RPOS pour savoir jusqu'à
// quelle date le magasin a réellement un historique de ventes disponible (ADMIN). RPOS n'expose
// aucune limite de rétention connue à l'avance ("l'API ne dit pas jusqu'où on peut remonter") :
// c'est la seule façon de le savoir, en demandant directement la toute première vente enregistrée.
// Distinct de /sales-lines/coverage (ce qui est déjà en BASE LOCALE) : ici on répond à "combien de
// jours puis-je encore récupérer en plus ?" en comparant à la limite réelle côté serveur.
router.get('/sales-lines/rpos-earliest-available', requireAdmin, async (req, res) => {
  try {
    const { shopId, posId } = req.query;
    if (!shopId || !posId) return res.status(400).json({ success: false, message: 'shopId et posId requis' });

    const earliestDate = await rpos.getEarliestSaleDate(posId, shopId);
    res.json({ success: true, data: { earliestDate } });
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

// GET /api/reassort/proposal/generate/preview-period?periodMode=&customStart=&customEnd= - calcule
// et renvoie les dates exactes (début/fin) qui seraient utilisées pour une génération, SANS lancer
// quoi que ce soit — pour que l'utilisateur voie concrètement quel intervalle sera analysé avant de
// confirmer (le mode par défaut ne dit pas la date réelle, calculée à partir de la dernière vente
// RÉELLE du magasin via RPOS, pas de la date système). periodMode vide = période configurée du
// magasin (comportement par défaut au lancement réel).
router.get('/proposal/generate/preview-period', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    if (!shopId || !posId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    const baseConfig = await getConfig(shopId);
    const { periodMode, customStart, customEnd } = req.query;
    const config = periodMode
      ? { ...baseConfig, periodMode, customStart: customStart || null, customEnd: customEnd || null }
      : baseConfig;

    const period = await resolvePeriod(posId, shopId, config);

    // Couverture locale réelle sur cette période (avant même de lancer quoi que ce soit) : permet
    // d'avertir l'utilisateur dans CE modal de confirmation si la base n'a pas encore toutes les
    // données de la période choisie, plutôt que de le découvrir après coup dans le bandeau de
    // résultat une fois la génération faite — bug constaté où une génération tournait
    // silencieusement sur des données partielles sans que rien ne le signale avant de lancer.
    const [earliestLocal, latestLocal] = await Promise.all([
      prisma.salesLine.findFirst({ where: { rposShopId: shopId, date: { gte: new Date(period.start), lt: new Date(period.end) } }, orderBy: { date: 'asc' }, select: { date: true } }),
      prisma.salesLine.findFirst({ where: { rposShopId: shopId, date: { gte: new Date(period.start), lt: new Date(period.end) } }, orderBy: { date: 'desc' }, select: { date: true } }),
    ]);

    let coverageWarning = null;
    if (!earliestLocal) {
      coverageWarning = { type: 'NO_DATA', message: 'Aucune donnée locale pour cette période — la génération devra tout récupérer depuis RPOS en direct (peut prendre plusieurs minutes).' };
    } else {
      const gapStartHours = (earliestLocal.date.getTime() - new Date(period.start).getTime()) / (60 * 60 * 1000);
      const gapEndHours = (new Date(period.end).getTime() - latestLocal.date.getTime()) / (60 * 60 * 1000);
      if (gapStartHours > 24) {
        coverageWarning = {
          type: 'PARTIAL_START',
          message: `Les données locales de ce magasin ne remontent qu'au ${earliestLocal.date.toLocaleDateString('fr-FR')} — ${Math.round(gapStartHours / 24)} jour(s) de début de période manquant(s). La génération complétera automatiquement via RPOS, mais cela peut ralentir le calcul.`,
        };
      } else if (gapEndHours > 24) {
        coverageWarning = {
          type: 'PARTIAL_END',
          message: `Les données locales de ce magasin s'arrêtent au ${latestLocal.date.toLocaleDateString('fr-FR')} — ${Math.round(gapEndHours / 24)} jour(s) de fin de période manquant(s) (synchro pas encore à jour).`,
        };
      }
    }

    res.json({ success: true, data: { ...period, coverageWarning } });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/proposal/generate?limit=<n> - génère et sauvegarde une proposition, à la
// demande. Ouvert aux comptes STORE (pour leur propre magasin) et ADMIN (avec ?shop=&pos=).
// Rejette l'ancienne proposition GENERATED du magasin si elle n'a pas encore été validée.
// Répond immédiatement avec un runId à suivre via GET /proposal/generate/:runId/status, au lieu de
// bloquer la requête HTTP jusqu'à la fin (jusqu'à plusieurs minutes sur un gros magasin avec appel
// RPOS) — même principe que /proposal/:id/validate, pour permettre une vraie barre de progression
// (étape en cours, X/Y articles traités, dernier article traité) plutôt qu'un déroulé simulé.
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

    const run = await prisma.proposalGenerationRun.create({
      data: { rposShopId: shopId, status: 'RUNNING', step: 'SALES' },
    });

    res.status(202).json({ success: true, data: { runId: run.id } });

    // Tâche de fond : la réponse HTTP est déjà partie, toute erreur ici est capturée et écrite sur
    // le run (jamais renvoyée au client via cette requête, qui a déjà répondu).
    (async () => {
      try {
        const onProgress = async (p) => {
          await prisma.proposalGenerationRun.update({
            where: { id: run.id },
            data: {
              step: p.step,
              ...(p.articlesTotal !== undefined ? { articlesTotal: p.articlesTotal } : {}),
              ...(p.articlesProcessed !== undefined ? { articlesProcessed: p.articlesProcessed } : {}),
              ...(p.lastArticleEan !== undefined ? { lastArticleEan: p.lastArticleEan } : {}),
              ...(p.lastArticleLabel !== undefined ? { lastArticleLabel: p.lastArticleLabel } : {}),
              ...(p.aiUnavailable !== undefined ? { aiUnavailable: p.aiUnavailable } : {}),
              ...(p.aiArticlesAdjusted !== undefined ? { aiArticlesAdjusted: p.aiArticlesAdjusted } : {}),
              ...(p.aiErrorMessage !== undefined ? { aiErrorMessage: p.aiErrorMessage } : {}),
            },
          }).catch(() => {}); // une mise à jour de progression manquée ne doit jamais interrompre la génération elle-même
        };

        const { proposal, weeklyPlanAttached } = await generateAndSaveProposal({ posId, shopId, shopReference, shopName, limit, periodOverride, onProgress });
        if (!weeklyPlanAttached) {
          console.warn(`[proposal/generate] ALERTE ${shopReference} : proposition ${proposal.id} sans plan hebdomadaire (prédictions non évaluables).`);
        }

        await prisma.proposalGenerationRun.update({
          where: { id: run.id },
          data: { status: 'DONE', step: 'DONE', proposalId: proposal.id, completedAt: new Date() },
        });
      } catch (error) {
        console.error('Proposal generate+save error:', error);
        await prisma.proposalGenerationRun.update({
          where: { id: run.id },
          data: { status: 'ERROR', errorMessage: error.message, completedAt: new Date() },
        }).catch(() => {});
      }
    })();
  } catch (error) {
    console.error('Proposal generate start error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal/generate/active?shop=... - le run de génération EN COURS pour ce
// magasin, s'il y en a un (RUNNING). Permet de retrouver une génération lancée puis dont le modal a
// été fermé (ou la page quittée/rechargée) sans l'annuler : la tâche de fond continue indépendamment
// du frontend, ce endpoint sert juste à savoir "est-ce qu'il y a quelque chose en cours ?" pour
// pouvoir rouvrir le suivi de progression.
router.get('/proposal/generate/active', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });

    const run = await prisma.proposalGenerationRun.findFirst({
      where: { rposShopId: shopId, status: 'RUNNING' },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: run ? { runId: run.id } : null });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal/generate/:runId/status - progression d'une génération en cours
// (polling, cf. commentaire ci-dessus). Répond aussi le contenu complet de la proposition une fois
// DONE (proposal + stats), pour éviter un second aller-retour au frontend une fois terminé.
router.get('/proposal/generate/:runId/status', async (req, res) => {
  try {
    const run = await prisma.proposalGenerationRun.findUnique({ where: { id: req.params.runId } });
    if (!run) return res.status(404).json({ success: false, message: 'Génération introuvable' });

    const shopId = resolveShopId(req);
    if (shopId && run.rposShopId !== shopId) {
      return res.status(403).json({ success: false, message: 'Cette génération n\'appartient pas à votre magasin' });
    }

    let proposal = null;
    if (run.status === 'DONE' && run.proposalId) {
      proposal = await prisma.proposal.findUnique({ where: { id: run.proposalId }, include: { lines: true } });
    }

    res.json({
      success: true,
      data: {
        status: run.status,
        step: run.step,
        articlesTotal: run.articlesTotal,
        articlesProcessed: run.articlesProcessed,
        lastArticleEan: run.lastArticleEan,
        lastArticleLabel: run.lastArticleLabel,
        errorMessage: run.errorMessage,
        aiUnavailable: run.aiUnavailable,
        aiArticlesAdjusted: run.aiArticlesAdjusted,
        aiErrorMessage: run.aiErrorMessage,
        proposal,
      },
    });
  } catch (error) {
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

// GET /api/reassort/proposal/history?shop=... - liste des générations passées d'un magasin (les
// plus récentes en premier), pour permettre de revenir consulter une proposition qui n'est plus
// "GENERATED" (déjà validée ou remplacée par une génération plus récente — REJECTED) : jusqu'ici
// purchase-order.html n'affichait plus rien dès qu'une proposition sortait du statut GENERATED,
// sans aucun moyen de la revoir.
router.get('/proposal/history', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const proposals = await prisma.proposal.findMany({
      where: { rposShopId: shopId },
      orderBy: { generatedAt: 'desc' },
      take: 30,
      select: { id: true, generatedAt: true, status: true },
    });
    res.json({ success: true, data: proposals });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/proposal/:id - une proposition précise par id, quel que soit son statut
// (GENERATED, REJECTED, VALIDATED...), avec ses lignes complètes — même format que
// GET /proposal/pending, pour réutiliser exactement le même rendu côté frontend.
router.get('/proposal/:id', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.id }, include: { lines: true } });
    if (!proposal) return res.status(404).json({ success: false, message: 'Proposition introuvable' });
    if (shopId && proposal.rposShopId !== shopId) {
      return res.status(403).json({ success: false, message: 'Cette proposition n\'appartient pas à votre magasin' });
    }
    res.json({ success: true, data: proposal });
  } catch (error) {
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

// GET /api/reassort/proposal/:id/excluded?reason=... - détail des articles exclus d'une catégorie
// (carte "Reste du CA magasin"), triés par part de CA magasin décroissante.
router.get('/proposal/:id/excluded', async (req, res) => {
  try {
    const { reason } = req.query;
    const where = { proposalId: req.params.id };
    if (reason) where.reason = reason;
    const items = await prisma.excludedArticle.findMany({
      where,
      orderBy: { revenueSharePct: 'desc' },
    });
    res.json({ success: true, data: items });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/weekly-plan/current?shop=... - plan hebdomadaire actif du magasin pour la
// semaine en cours (CAHIER_DES_CHARGES.md §11-13, étape 2).
router.get('/weekly-plan/current', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const plan = await findWeeklyPlanForDate(shopId);
    if (!plan) return res.json({ success: true, data: null });
    const history = await getWeeklyPlanHistory(plan.id);
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/weekly-plan/:id/history - historique des révisions d'un plan donné, avec
// l'évolution de la quantité proposée par article entre révisions.
router.get('/weekly-plan/:id/history', async (req, res) => {
  try {
    const history = await getWeeklyPlanHistory(req.params.id);
    if (!history) return res.status(404).json({ success: false, message: 'Plan hebdomadaire introuvable' });
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/predictions/proposals - liste des propositions du magasin courant (les plus
// récentes en premier), pour alimenter le sélecteur de la page "IA & Prédictions" : permet de
// consulter les prédictions d'une génération passée, pas seulement la toute dernière.
router.get('/predictions/proposals', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const proposals = await prisma.proposal.findMany({
      where: { rposShopId: shopId, predictions: { some: {} } },
      orderBy: { generatedAt: 'desc' },
      take: 30,
      select: { id: true, generatedAt: true, status: true },
    });
    res.json({ success: true, data: proposals });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/predictions - prédictions du magasin courant pour une proposition donnée
// (?proposalId=... ; par défaut la plus récente), triées par score de confiance croissant (les
// moins fiables d'abord, celles qui méritent le plus d'attention). Enrichit chaque prédiction avec
// le détail déjà calculé sur ProposalLine (historique jour par jour, stock, commandes en cours...)
// pour permettre d'expliquer une recommandation sans aucun recalcul.
router.get('/predictions', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }

    let proposalId = req.query.proposalId;
    if (!proposalId) {
      const latestProposal = await prisma.proposal.findFirst({
        where: { rposShopId: shopId },
        orderBy: { generatedAt: 'desc' },
        select: { id: true },
      });
      if (!latestProposal) return res.json({ success: true, data: { proposalId: null, generatedAt: null, predictions: [] } });
      proposalId = latestProposal.id;
    }

    const proposal = await prisma.proposal.findUnique({ where: { id: proposalId }, select: { id: true, rposShopId: true, generatedAt: true } });
    if (!proposal || proposal.rposShopId !== shopId) {
      return res.status(404).json({ success: false, message: 'Proposition introuvable pour ce magasin' });
    }

    const [predictions, lines] = await Promise.all([
      prisma.aIPrediction.findMany({
        where: { proposalId },
        orderBy: { confidenceScore: 'asc' },
        include: { outcome: true },
      }),
      prisma.proposalLine.findMany({
        where: { proposalId },
        select: { ean: true, stockAtGeneration: true, currentOrderedQuantity: true, dailyHistory: true, revenueSharePct: true, forecastMethod: true, department: true, sector: true, classicQuantitySuggested: true, aiAdjusted: true, aiReasoning: true, excludedAsAlreadyOrderedRpos: true, rposOrderReference: true, rposOrderDate: true, rposOrderCount: true, orderingUnit: true, avgWeeklySales: true, daysUntilStockout: true },
      }),
    ]);

    const lineByEan = new Map(lines.map((l) => [l.ean, l]));
    const enriched = predictions.map((p) => {
      const line = lineByEan.get(p.ean);
      let dailyHistory = [];
      if (line?.dailyHistory) {
        try { dailyHistory = JSON.parse(line.dailyHistory); } catch { dailyHistory = []; }
      }
      return {
        ...p,
        dailyHistory,
        revenueSharePct: line?.revenueSharePct ?? null,
        classicQuantitySuggested: line?.classicQuantitySuggested ?? null,
        aiAdjusted: line?.aiAdjusted ?? false,
        aiReasoningAtGeneration: line?.aiReasoning ?? null,
        hasRecentOrder: line?.excludedAsAlreadyOrderedRpos ?? false,
        recentOrderReference: line?.rposOrderReference ?? null,
        recentOrderDate: line?.rposOrderDate ?? null,
        recentOrderCount: line?.rposOrderCount ?? null,
        department: line?.department || 'Autre',
        sector: line?.sector || null,
        orderingUnit: line?.orderingUnit ?? null,
        avgWeeklySales: line?.avgWeeklySales ?? null,
        daysUntilStockout: line?.daysUntilStockout ?? null,
      };
    });

    res.json({ success: true, data: { proposalId, generatedAt: proposal.generatedAt, predictions: enriched } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/predictions/history - historique de ventes journalier d'un article (panneau
// de détail de la page "IA & Prédictions"), sur une plage de dates choisie par l'utilisateur —
// indépendante de la période d'analyse figée utilisée par la prédiction elle-même (dailyHistory
// sur ProposalLine). Lit uniquement SalesLine (déjà synchronisé localement) : aucun appel RPOS.
// Query: shop (requis), ean (requis), days (7/30/90, défaut 30).
router.get('/predictions/history', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const { ean } = req.query;
    if (!shopId) return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    if (!ean) return res.status(400).json({ success: false, message: 'ean requis' });

    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const dateEnd = new Date();
    const requestedStart = new Date(dateEnd.getTime() - days * 24 * 60 * 60 * 1000);

    // Bug constaté (session du 11/09) : compléter aveuglément chaque jour de la période DEMANDÉE
    // avec 0 fabriquait de fausses "ventes nulles" pour des jours où la base locale n'a en réalité
    // AUCUNE donnée (magasin dont la synchro/backfill ne couvre que quelques jours) — un tableau
    // "30 jours" sur un magasin qui n'a que 4 jours d'historique affichait 26 lignes à 0 inventées,
    // indiscernables visuellement d'une vraie absence de vente. On borne donc la période retournée
    // à la couverture RÉELLE de la base (première vente connue pour ce magasin, tous articles
    // confondus), jamais au-delà — un jour hors de cette borne est absent du tableau plutôt que
    // faussement à 0 ; un jour DANS la borne mais sans vente pour CET article reste à 0 (une vraie
    // information : le magasin vendait, cet article non).
    const earliestKnown = await prisma.salesLine.findFirst({
      where: { rposShopId: shopId },
      orderBy: { date: 'asc' },
      select: { date: true },
    });
    const dateStart = earliestKnown && earliestKnown.date > requestedStart ? earliestKnown.date : requestedStart;
    const coverageLimited = earliestKnown && earliestKnown.date > requestedStart;

    const lines = await prisma.salesLine.findMany({
      where: { rposShopId: shopId, ean, date: { gte: dateStart, lte: dateEnd } },
      select: { date: true, quantity: true },
      orderBy: { date: 'asc' },
    });

    const byDay = new Map();
    for (const line of lines) {
      const day = line.date.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + line.quantity);
    }
    // Complète chaque jour DANS la période réellement couverte à 0 (pas absent) : une rupture de
    // plusieurs jours pour cet article précis doit être visible sur le graphique, distincte d'une
    // période hors couverture (qui n'apparaît pas du tout, cf. borne dateStart ci-dessus).
    const dailyHistory = [];
    for (let d = new Date(dateStart); d <= dateEnd; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      dailyHistory.push({ date: key, quantity: Math.round((byDay.get(key) || 0) * 100) / 100 });
    }

    res.json({
      success: true,
      data: {
        days,
        dailyHistory,
        // coverageLimited=true : le magasin n'a pas d'historique local aussi loin que "days" jours
        // demandés — le frontend peut alors afficher "X jours disponibles sur Y demandés" plutôt
        // que de laisser croire que toute la période demandée a été analysée.
        coverageLimited,
        actualDays: dailyHistory.length,
      },
    });
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
      treatNegativeStockAsZero, revenueSharePeriodDays, overstockThresholdMultiplier, splitOrdersByDepartment, forecastAccuracyWindowDays, forecastAccuracyThresholdPct, seasonalityComparisonEnabled, seasonalityLookbackYears, seasonalityAdjustmentThresholdPct, receptionLeadTimeDays, useReceptionLeadTimeInCalculation, excludeGenericArticlesBelowPrice, recentOrderMaxAgeDays, forecastEnabled, forecastAlpha, ignoreRposStockInCalculation,
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
    if (ignoreRposStockInCalculation !== undefined) data.ignoreRposStockInCalculation = ignoreRposStockInCalculation;

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
      treatNegativeStockAsZero, revenueSharePeriodDays, overstockThresholdMultiplier, splitOrdersByDepartment, forecastAccuracyWindowDays, forecastAccuracyThresholdPct, seasonalityComparisonEnabled, seasonalityLookbackYears, seasonalityAdjustmentThresholdPct, receptionLeadTimeDays, useReceptionLeadTimeInCalculation, excludeGenericArticlesBelowPrice, recentOrderMaxAgeDays, forecastEnabled, forecastAlpha, ignoreRposStockInCalculation,
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
    if (ignoreRposStockInCalculation !== undefined) data.ignoreRposStockInCalculation = ignoreRposStockInCalculation;

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

// GET /api/reassort/system-config/jobs-health - état des 4 jobs planifiés (dernier statut, nombre
// d'échecs consécutifs) : les échecs de cron n'étaient auparavant visibles que dans les logs
// serveur, sans aucun moyen de les consulter depuis l'UI.
router.get('/system-config/jobs-health', requireAdmin, async (req, res) => {
  try {
    const jobsHealth = await jobHealthService.getJobsHealth();
    res.json({ success: true, data: jobsHealth });
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

    const CRON_KEYS = [
      systemConfig.KEYS.NIGHTLY_PROPOSAL_CRON,
      systemConfig.KEYS.RECEPTION_SYNC_CRON,
      systemConfig.KEYS.SALES_SYNC_CRON,
      systemConfig.KEYS.SHOPS_SYNC_CRON,
      systemConfig.KEYS.DAILY_REVIEW_CRON,
      systemConfig.KEYS.PREDICTION_OUTCOME_CRON,
    ];
    if (CRON_KEYS.includes(key)) {
      const cron = require('node-cron');
      if (!cron.validate(value)) {
        return res.status(400).json({ success: false, message: 'Expression cron invalide' });
      }
    }

    if (key === systemConfig.KEYS.REVISION_CHANGE_THRESHOLD) {
      const threshold = parseFloat(value);
      if (Number.isNaN(threshold) || threshold < 0 || threshold > 1) {
        return res.status(400).json({ success: false, message: 'Seuil invalide : nombre entre 0 et 1 (ex: 0.10 pour 10%)' });
      }
    }

    if (key === systemConfig.KEYS.ANOMALY_MIN_DAILY_SALES) {
      const threshold = parseFloat(value);
      if (!Number.isFinite(threshold) || threshold < 0) {
        return res.status(400).json({ success: false, message: 'Seuil invalide : nombre positif ou nul, en unités/jour (ex: 1, 0.5, 0)' });
      }
    }

    const ENABLED_KEYS = [
      systemConfig.KEYS.NIGHTLY_PROPOSAL_ENABLED,
      systemConfig.KEYS.RECEPTION_SYNC_ENABLED,
      systemConfig.KEYS.SALES_SYNC_ENABLED,
      systemConfig.KEYS.SHOPS_SYNC_ENABLED,
      systemConfig.KEYS.DAILY_REVIEW_ENABLED,
      systemConfig.KEYS.PREDICTION_OUTCOME_ENABLED,
    ];
    if (ENABLED_KEYS.includes(key) && !['true', 'false'].includes(value)) {
      return res.status(400).json({ success: false, message: 'Valeur invalide : "true" ou "false" attendu' });
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
    if ([systemConfig.KEYS.NIGHTLY_PROPOSAL_CRON, systemConfig.KEYS.NIGHTLY_PROPOSAL_ENABLED].includes(key)) {
      const { startOrRestartNightlyJob } = require('../jobs/cronManager');
      await startOrRestartNightlyJob();
    }
    if ([systemConfig.KEYS.RECEPTION_SYNC_CRON, systemConfig.KEYS.RECEPTION_SYNC_ENABLED].includes(key)) {
      const { startOrRestartReceptionSyncJob } = require('../jobs/cronManager');
      await startOrRestartReceptionSyncJob();
    }
    if ([systemConfig.KEYS.SALES_SYNC_CRON, systemConfig.KEYS.SALES_SYNC_ENABLED].includes(key)) {
      const { startOrRestartSalesSyncJob } = require('../jobs/cronManager');
      await startOrRestartSalesSyncJob();
    }
    if ([systemConfig.KEYS.SHOPS_SYNC_CRON, systemConfig.KEYS.SHOPS_SYNC_ENABLED].includes(key)) {
      const { startOrRestartShopsSyncJob } = require('../jobs/cronManager');
      await startOrRestartShopsSyncJob();
    }
    if ([systemConfig.KEYS.DAILY_REVIEW_CRON, systemConfig.KEYS.DAILY_REVIEW_ENABLED].includes(key)) {
      const { startOrRestartDailyReviewJob } = require('../jobs/cronManager');
      await startOrRestartDailyReviewJob();
    }
    if ([systemConfig.KEYS.PREDICTION_OUTCOME_CRON, systemConfig.KEYS.PREDICTION_OUTCOME_ENABLED].includes(key)) {
      const { startOrRestartPredictionOutcomeJob } = require('../jobs/cronManager');
      await startOrRestartPredictionOutcomeJob();
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

// POST /api/reassort/shop-activity/warm - déclenche le calcul du profil d'activité du magasin
// (shopActivityService) en arrière-plan, SANS attendre le résultat (répond immédiatement) : à
// appeler dès qu'un magasin est sélectionné sur une page qui propose l'analyse IA par article, pour
// que ce profil soit déjà en cache (24h) au moment du premier clic "Analyser" — évite de faire
// attendre l'utilisateur ~15-30s sur ce calcul au moment précis où il veut un résultat rapide.
// Idempotent et sans risque : un appel répété pendant que le cache est déjà chaud ne fait rien
// (getShopActivityProfile relit le cache directement).
router.post('/shop-activity/warm', async (req, res) => {
  const shopId = resolveShopId(req);
  const posId = resolvePosId(req);
  res.json({ success: true }); // répond tout de suite, le calcul continue derrière
  if (!shopId || !posId) return;
  shopActivityService.getShopActivityProfile(posId, shopId).catch(() => {}); // best-effort, jamais bloquant
});

// POST /api/reassort/proposal/:proposalId/ai-analyze-article - analyse IA en direct d'un seul
// article (page "IA & Prédictions") : appel LLM immédiat, sans persistance (AiForecastRun est pour
// une génération complète, pas une analyse ponctuelle). Body: { ean }.
router.post('/proposal/:proposalId/ai-analyze-article', async (req, res) => {
  try {
    const { ean } = req.body;
    if (!ean) return res.status(400).json({ success: false, message: 'ean requis' });

    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal) return res.status(404).json({ success: false, message: 'Proposition introuvable' });

    const shopId = resolveShopId(req);
    if (shopId && proposal.rposShopId !== shopId) {
      return res.status(403).json({ success: false, message: 'Cette proposition n\'appartient pas à votre magasin' });
    }

    const line = await prisma.proposalLine.findFirst({ where: { proposalId: proposal.id, ean } });
    if (!line) return res.status(404).json({ success: false, message: 'Article introuvable dans cette proposition' });

    const result = await aiForecastService.analyzeArticleRealtime({
      shopReference: proposal.rposShopReference,
      shopName: proposal.rposShopName,
      line,
      shopConfig: { safetyStockRatio: proposal.safetyStockRatioUsed, receptionLeadTimeDays: proposal.receptionLeadTimeDaysUsed },
      posId: proposal.rposPosId,
      shopId: proposal.rposShopId,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/proposal/:proposalId/ai-analyze-article-stream - variante streamée (SSE) de la
// route ci-dessus : le texte de l'IA s'affiche au fur et à mesure côté frontend (façon
// conversation), plutôt que d'attendre la réponse complète avant de tout afficher d'un coup. POST
// (pas l'EventSource natif du navigateur, qui ne supporte ni POST ni header Authorization custom) :
// le frontend consomme ce flux via fetch() + response.body.getReader(), même mécanisme que celui
// utilisé côté serveur pour lire les flux des fournisseurs LLM. Body: { ean }.
router.post('/proposal/:proposalId/ai-analyze-article-stream', async (req, res) => {
  const { ean } = req.body;
  if (!ean) return res.status(400).json({ success: false, message: 'ean requis' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal) { send('error', { message: 'Proposition introuvable' }); return res.end(); }

    const shopId = resolveShopId(req);
    if (shopId && proposal.rposShopId !== shopId) {
      send('error', { message: 'Cette proposition n\'appartient pas à votre magasin' });
      return res.end();
    }

    const line = await prisma.proposalLine.findFirst({ where: { proposalId: proposal.id, ean } });
    if (!line) { send('error', { message: 'Article introuvable dans cette proposition' }); return res.end(); }

    const result = await aiForecastService.analyzeArticleRealtimeStream({
      shopReference: proposal.rposShopReference,
      shopName: proposal.rposShopName,
      line,
      shopConfig: { safetyStockRatio: proposal.safetyStockRatioUsed, receptionLeadTimeDays: proposal.receptionLeadTimeDaysUsed },
      posId: proposal.rposPosId,
      shopId: proposal.rposShopId,
      onQuantity: (quantity) => send('quantity', { quantity }),
      onTextChunk: (text) => send('chunk', { text }),
    });

    send('done', result);
    res.end();
  } catch (error) {
    send('error', { message: error.message });
    res.end();
  }
});

// POST /api/reassort/proposal/:proposalId/ai-ask-followup-stream - question libre du magasin sur
// une recommandation déjà donnée (cf. demande explicite : "le magasin doit pouvoir demander à l'IA
// pourquoi elle recommande une quantité donnée", "combien de jours cette commande va-t-elle
// couvrir ?", etc.). Streamé en SSE comme l'analyse initiale. Body: { ean, previousQuantity,
// previousReasoning, conversationHistory, question }.
router.post('/proposal/:proposalId/ai-ask-followup-stream', async (req, res) => {
  const { ean, previousQuantity, previousReasoning, conversationHistory, question } = req.body;
  if (!ean || !question) return res.status(400).json({ success: false, message: 'ean et question sont requis' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal) { send('error', { message: 'Proposition introuvable' }); return res.end(); }

    const shopId = resolveShopId(req);
    if (shopId && proposal.rposShopId !== shopId) {
      send('error', { message: 'Cette proposition n\'appartient pas à votre magasin' });
      return res.end();
    }

    const line = await prisma.proposalLine.findFirst({ where: { proposalId: proposal.id, ean } });
    if (!line) { send('error', { message: 'Article introuvable dans cette proposition' }); return res.end(); }

    const result = await aiForecastService.askFollowUpQuestion({
      shopReference: proposal.rposShopReference,
      shopName: proposal.rposShopName,
      line,
      shopConfig: { safetyStockRatio: proposal.safetyStockRatioUsed, receptionLeadTimeDays: proposal.receptionLeadTimeDaysUsed },
      posId: proposal.rposPosId,
      shopId: proposal.rposShopId,
      previousQuantity,
      previousReasoning,
      conversationHistory,
      question,
      onTextChunk: (text) => send('chunk', { text }),
    });

    send('done', result);
    res.end();
  } catch (error) {
    send('error', { message: error.message });
    res.end();
  }
});

// GET /api/reassort/chatbot/suggested-questions - questions suggérées (§34), éditables depuis
// Paramètres > IA (CHATBOT_SUGGESTED_QUESTIONS, une par ligne) sans redéploiement.
router.get('/chatbot/suggested-questions', async (req, res) => {
  res.json({ success: true, data: await chatbotService.getSuggestedQuestions() });
});

// GET /api/reassort/chatbot/conversations - liste des conversations de l'utilisateur connecté
// (toutes magasins confondus, plus récentes d'abord), pour la liste latérale façon ChatGPT.
router.get('/chatbot/conversations', async (req, res) => {
  try {
    const conversations = await prisma.chatbotConversation.findMany({
      where: { userId: req.user.id },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, rposShopId: true, department: true, subDepartment: true, updatedAt: true },
      take: 100,
    });
    res.json({ success: true, data: conversations });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/chatbot/conversations/:id - messages complets d'une conversation (vérifie
// qu'elle appartient bien à l'utilisateur connecté, jamais l'historique d'un autre compte).
router.get('/chatbot/conversations/:id', async (req, res) => {
  try {
    const conversation = await prisma.chatbotConversation.findUnique({
      where: { id: req.params.id },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation || conversation.userId !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Conversation introuvable' });
    }
    res.json({ success: true, data: conversation });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE /api/reassort/chatbot/conversations/:id - supprime une conversation (et ses messages, cascade).
router.delete('/chatbot/conversations/:id', async (req, res) => {
  try {
    const conversation = await prisma.chatbotConversation.findUnique({ where: { id: req.params.id } });
    if (!conversation || conversation.userId !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Conversation introuvable' });
    }
    await prisma.chatbotConversation.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/chatbot/ask-stream - AI Store Assistant (CAHIER_DES_CHARGES.md §34-38, étape
// 11) : question libre du responsable magasin, avec contexte magasin/rayon/sous-rayon. Streamé en
// SSE comme les autres analyses IA. Body: { conversationId (optionnel, crée une nouvelle
// conversation si absent), department, subDepartment, question }. Le magasin est déterminé par
// resolveShopId (permission de l'utilisateur), jamais par un paramètre libre côté client — cohérent
// avec §43 (le chatbot ne doit jamais pouvoir contourner les permissions pour consulter un autre
// magasin). Chaque question/réponse est persistée (ChatbotMessage) pour l'historique.
router.post('/chatbot/ask-stream', async (req, res) => {
  const { conversationId, department, subDepartment, question } = req.body;
  if (!question) return res.status(400).json({ success: false, message: 'question requise' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const shopId = resolveShopId(req);
    if (!shopId) { send('error', { message: 'Aucun magasin assigné à ce compte' }); return res.end(); }

    const shop = await prisma.shop.findUnique({ where: { rposShopId: shopId } });
    if (!shop) { send('error', { message: 'Magasin introuvable' }); return res.end(); }

    let conversation = conversationId
      ? await prisma.chatbotConversation.findUnique({ where: { id: conversationId }, include: { messages: { orderBy: { createdAt: 'asc' } } } })
      : null;
    if (conversation && conversation.userId !== req.user.id) {
      send('error', { message: 'Cette conversation ne vous appartient pas' });
      return res.end();
    }
    if (!conversation) {
      conversation = await prisma.chatbotConversation.create({
        data: {
          userId: req.user.id,
          rposShopId: shopId,
          title: question.slice(0, 80),
          department: department || null,
          subDepartment: subDepartment || null,
        },
        include: { messages: true },
      });
    }

    // Reconstruit les tours question/réponse en parcourant les messages dans l'ordre (déjà triés
    // par createdAt asc) : chaque message "user" est suivi de sa réponse "assistant" correspondante.
    const conversationHistory = [];
    for (let i = 0; i < conversation.messages.length - 1; i++) {
      if (conversation.messages[i].role === 'user' && conversation.messages[i + 1].role === 'assistant') {
        conversationHistory.push({
          question: conversation.messages[i].content,
          answer: conversation.messages[i + 1].content,
          toolUsed: conversation.messages[i + 1].toolUsed || null,
          toolResult: conversation.messages[i + 1].toolResult ? JSON.parse(conversation.messages[i + 1].toolResult) : null,
        });
      }
    }

    await prisma.chatbotMessage.create({ data: { conversationId: conversation.id, role: 'user', content: question } });

    const result = await chatbotService.askAssistant({
      rposShopId: shopId,
      shopReference: shop.reference,
      shopName: shop.name,
      department: department || conversation.department,
      subDepartment: subDepartment || conversation.subDepartment,
      conversationHistory,
      question,
      onTextChunk: (text) => send('chunk', { text }),
    });

    await Promise.all([
      prisma.chatbotMessage.create({ data: { conversationId: conversation.id, role: 'assistant', content: result.answer, toolUsed: result.toolUsed, toolResult: result.toolResult ? JSON.stringify(result.toolResult) : null } }),
      prisma.chatbotConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } }),
    ]);

    send('done', { ...result, conversationId: conversation.id });
    res.end();
  } catch (error) {
    send('error', { message: error.message });
    res.end();
  }
});

// PUT /api/reassort/proposal/:proposalId/line-quantity - applique une quantité choisie par
// l'utilisateur (page "IA & Prédictions") sur une ligne de proposition : la recommandation IA
// n'est jamais imposée automatiquement, l'utilisateur reste décisionnaire (peut commander moins,
// plus, ou suivre l'IA telle quelle). Ne touche qu'à ProposalLine.quantitySuggested — la
// validation/envoi vers RPOS reste sur purchase-order.html comme aujourd'hui.
router.put('/proposal/:proposalId/line-quantity', async (req, res) => {
  try {
    const { ean, quantity } = req.body;
    if (!ean) return res.status(400).json({ success: false, message: 'ean requis' });
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({ success: false, message: 'quantity doit être un nombre positif ou nul' });
    }

    const proposal = await prisma.proposal.findUnique({ where: { id: req.params.proposalId } });
    if (!proposal) return res.status(404).json({ success: false, message: 'Proposition introuvable' });

    const shopId = resolveShopId(req);
    if (shopId && proposal.rposShopId !== shopId) {
      return res.status(403).json({ success: false, message: 'Cette proposition n\'appartient pas à votre magasin' });
    }
    if (proposal.status !== 'GENERATED') {
      return res.status(409).json({ success: false, message: 'Cette proposition n\'est plus modifiable (déjà validée ou remplacée)' });
    }

    const line = await prisma.proposalLine.findFirst({ where: { proposalId: proposal.id, ean } });
    if (!line) return res.status(404).json({ success: false, message: 'Article introuvable dans cette proposition' });

    const updated = await prisma.proposalLine.update({
      where: { id: line.id },
      data: { quantitySuggested: Math.round(qty) },
    });
    res.json({ success: true, data: { ean: updated.ean, quantitySuggested: updated.quantitySuggested } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/error-reports - capteur frontend du debug global : chaque page interne
// remonte ses erreurs JS non capturées (layout.js, TOUTES les pages/vues couvertes).
// Authentifié mais pas forcément ADMIN (les erreurs des comptes STORE sont précieuses aussi) —
// le regroupement et la déduplication se font côté chien de garde, ici on journalise juste
// (plafond anti-spam côté client : 20 envois + dédup 60s par page chargée).
router.post('/error-reports', async (req, res) => {
  try {
    const { page, message, stack } = req.body;
    if (!message) return res.status(400).json({ success: false, message: 'message requis' });
    await errorReportService.reportError({
      source: 'frontend',
      page: page || null,
      message,
      stack: stack || null,
      userEmail: (req.user && req.user.email) || null,
      shopRef: (req.user && req.user.rposShopReference) || null,
      ip: req.ip || null,
      userAgent: req.get('User-Agent') || null,
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/error-reports/recent - journal d'audit des erreurs (base du debug global) :
// les 100 dernières erreurs capturées (toutes pages frontend + toutes API 5xx), les plus
// récentes d'abord. Réservé ADMIN. Prouve que les bugs sont bien sauvés avant analyse.
router.get('/error-reports/recent', requireAdmin, async (req, res) => {
  try {
    const rows = await prisma.errorReport.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const total = await prisma.errorReport.count();
    res.json({ success: true, data: { total, rows } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/improvements - Conseiller d'amélioration IA (première brique AI Center,
// §44) : constats persistés avec priorité, statut et timeline.
// ?status= & ?priority= pour filtrer, ?sort=priority (défaut, critiques d'abord) ou recent.
// Réservé ADMIN : pilotage global du système, pas par magasin.
router.get('/improvements', requireAdmin, async (req, res) => {
  try {
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.priority) where.priority = req.query.priority;
    const rows = await prisma.aIImprovement.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 });
    const rank = improvementService.PRIORITY_RANK;
    if ((req.query.sort || 'priority') === 'priority') {
      rows.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9) || b.createdAt - a.createdAt);
    }
    res.json({ success: true, data: rows.map((r) => ({ ...r, evidence: r.evidence ? JSON.parse(r.evidence) : null })) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/improvements/health - constats ACTUELS du chien de garde, sans rien
// persister : aperçu instantané avant de lancer une génération.
router.get('/improvements/health', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await improvementService.collectFindings() });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/improvements/:id - détail complet + timeline des événements
// (Détection → Analyse IA → Recommandation → Validation → Correction → Vérification → Résultat).
router.get('/improvements/:id', requireAdmin, async (req, res) => {
  try {
    const row = await prisma.aIImprovement.findUnique({
      where: { id: req.params.id },
      include: { events: { orderBy: { at: 'asc' } } },
    });
    if (!row) return res.status(404).json({ success: false, message: 'Recommandation introuvable' });
    res.json({ success: true, data: { ...row, evidence: row.evidence ? JSON.parse(row.evidence) : null } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});
// POST /api/reassort/improvements/generate - lance le cycle complet : détection des anomalies
// silencieuses, persistance (dédupliquée), enrichissement IA des priorités, puis évaluation
// d'effet des recommandations précédemment appliquées (boucle d'apprentissage). Le contexte
// Qui/Où (email, IP, version, environnement) est figé sur chaque constat pour traçabilité.
router.post('/improvements/generate', requireAdmin, async (req, res) => {
  try {
    let appVersion = null;
    try { appVersion = require('../../package.json').version || null; } catch { appVersion = null; }
    const data = await improvementService.generateImprovements({
      actor: (req.user && req.user.email) || 'admin',
      ip: req.ip || null,
      appVersion,
      environment: process.env.NODE_ENV || 'production',
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error('[improvements/generate]', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/reassort/improvements/:id - ajuste la proposition IA (recommandation, reco dev,
// priorité). La proposition de l'IA est modifiable par l'humain avant application ; chaque
// modification est tracée dans la timeline (action EDITED). Interdit sur APPLIED/IMPROVED
// (clôturées : rouvrir d'abord).
router.put('/improvements/:id', requireAdmin, async (req, res) => {
  try {
    const { detail, devRecommendation, priority } = req.body;
    const data = await improvementService.updateImprovement(req.params.id, { detail, devRecommendation, priority }, {
      actor: (req.user && req.user.email) || 'admin',
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});
// POST /api/reassort/improvements/:id/status - { status, note? } : l'humain reste décisionnaire.
// Statuts : IN_PROGRESS (en cours), TO_VERIFY (à vérifier), APPLIED (appliqué + note de ce qui
// a réellement été fait), DISMISSED (ignoré + motif obligatoire), PROPOSED (rouvrir).
// IMPROVED/NO_EFFECT sont posés par le système seul (évaluation), jamais à la main.
// Chaque transition est tracée (acteur, note) dans la timeline — rien ne disparaît.
router.post('/improvements/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, note } = req.body;
    const data = await improvementService.setImprovementStatus(req.params.id, status, {
      actor: (req.user && req.user.email) || 'admin',
      note: (note || '').slice(0, 2000) || null,
    });
    res.json({ success: true, data });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
});

module.exports = router;
