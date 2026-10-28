// Sous-routeur 'insights' — Plans hebdo, predictions, statistiques (conformite, ruptures, surstock, precision).
// Monte dans routes/reassort/index.js sous le prefixe /api/reassort (requireAuth +
// requireSupervisedShop appliques la-bas, pas ici). Ne jamais monter ailleurs.
const express = require('express');
const router = express.Router();
const { requireAdminOrSupervisor, getAccessibleShopIds, resolveShopId, resolvePosId, SINGLE_SHOP_ROLES } = require('../../middleware/auth');
const prisma = require('../../utils/prisma');
const rpos = require('../../services/rposClient');
const {
  getConformityRate,
  getWeeklyConformityRate,
  getTodayProposalShops,
  getStockoutRate,
  getShadowAiReport,
  getAiDecisionLog,
  getAdminDashboard,
  getRecentUndeliveredOrderedQuantityCached,
} = require('../../services/proposalService');
const { getConfig } = require('../../services/configService');
const productInsightCache = require('../../services/productInsightCacheService');
const productAnalyticsService = require('../../services/productAnalyticsService');
const { getParetoArticles } = require('../../services/chatbotToolsService');
const stockMoveAnalysis = require('../../services/stockMoveAnalysisService');
const { getDashboardSummary, getDashboardSummaryAllShops, getDashboardSummaryByDepartment, getDashboardSummaryBySector, getEpisodeDetail, getTrend: getStockoutTrend, getPeriodLossSummary, analyzePeriodLoss, analyzeEpisode } = require('../../services/stockoutEpisodeService');
const { DEFAULT_PERIOD_DAYS: STOCKOUT_PERIOD_SNAPSHOT_DAYS } = require('../../jobs/stockoutPeriodSummarySnapshotJob');
const { filterProposalLinesForUser } = require('../../services/aiPermissionsService');
const { getOverstockReport, getOverstockByShop, getOverstockByShopPage, getOverstockOverPeriod, getOverstockDataAvailability, getCachedDefaultOverstockReport, getScrapDetailForArticle, getSalesDetailForArticle, getEndOfLifeDetailForArticle, DEFAULT_MIN_WEEKS_OF_COVERAGE } = require('../../services/overstockReportService');
const { getScrapOverview, getMovementTypes } = require('../../services/scrapReportService');
const { CACHE_KEY: OVERSTOCK_REPORT_CACHE_KEY, PERIOD_90D_CACHE_KEY: OVERSTOCK_REPORT_PERIOD_90D_CACHE_KEY, PERIOD_90D_DAYS: OVERSTOCK_REPORT_PERIOD_90D_DAYS } = require('../../jobs/overstockReportSnapshotJob');

// Un Rayonniste/Chef de département ne doit pas pouvoir consulter les données d'un article hors de
// son périmètre simplement en connaissant/devinant son EAN — utilisé par toutes les routes ciblant
// un article précis via ?ean= (pas une liste déjà filtrée en amont). Retourne true si l'accès est
// autorisé (rôles non restreints par département toujours autorisés, cf. filterProposalLinesForUser).
async function isEanInUserScope(req, shopId, ean) {
  const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
  const latestLineForEan = await prisma.proposalLine.findFirst({
    where: { ean, proposal: { rposShopId: shopId } },
    orderBy: { proposal: { generatedAt: 'desc' } },
    select: { department: true },
  });
  if (!latestLineForEan) return true; // article jamais proposé : rien à restreindre ici
  return filterProposalLinesForUser([latestLineForEan], currentUser).length > 0;
}

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
        select: { ean: true, stockAtGeneration: true, currentOrderedQuantity: true, dailyHistory: true, revenueSharePct: true, forecastMethod: true, department: true, sector: true, classicQuantitySuggested: true, aiAdjusted: true, aiReasoning: true, aiAction: true, excludedAsAlreadyOrderedRpos: true, rposOrderReference: true, rposOrderDate: true, rposOrderCount: true, orderingUnit: true, avgWeeklySales: true, daysUntilStockout: true },
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
        aiAction: line?.aiAction ?? null,
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

    // Même restriction par département/rayon que GET /proposal/pending (plan de rôles, étape 3) :
    // sans ce filtre, un Rayonniste voyait ici les prédictions IA de TOUS les rayons du magasin,
    // contournant la restriction déjà appliquée sur la page "Proposition de commande" — bug trouvé
    // le 16/09/2026 lors de l'audit des routes non couvertes par le premier passage.
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.id } });
    const filteredPredictions = filterProposalLinesForUser(enriched, currentUser);

    res.json({ success: true, data: { proposalId, generatedAt: proposal.generatedAt, predictions: filteredPredictions } });
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
    if (!(await isEanInUserScope(req, shopId, ean))) {
      return res.status(403).json({ success: false, message: 'Cet article n\'est pas dans votre périmètre.' });
    }

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

// GET /api/reassort/top-articles?days=30 - top 5 articles par CA réel sur les ventes (Tableau de
// bord, 30/09/2026) — réutilise getParetoArticles (chatbotToolsService.js), déjà utilisée par le
// chatbot pour classer les articles par CA réel (SalesLine.revenueExclTax), jamais dupliquée ici.
// Volontairement PAS la proposition en attente (GET /reassort/proposal/pending) : elle ne liste que
// les articles à réapprovisionner ce jour-là, pas un vrai "top ventes" du magasin. days=30 fixe
// (pas la période complète configurée du magasin, potentiellement 1 an) : ce widget est un simple
// aperçu, pas une analyse Pareto complète.
router.get('/top-articles', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    const posId = resolvePosId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const result = await getParetoArticles(posId, shopId, { days: 30 });
    if (!result.found) return res.json({ success: true, data: { found: false, lines: [] } });
    res.json({ success: true, data: { found: true, lines: result.lines.slice(0, 5) } });
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
    const result = await getConformityRate(shopId, { start: req.query.start, end: req.query.end });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/conformity/weekly?weeks=10 - taux de conformité semaine par semaine (Tableau
// de bord, graphique de tendance, 30/09/2026) — même définition que /conformity ci-dessus, juste
// regroupé par semaine de validation au lieu d'un agrégat unique.
router.get('/conformity/weekly', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const weeksRaw = parseInt(req.query.weeks, 10);
    const weeks = Number.isFinite(weeksRaw) ? Math.min(26, Math.max(4, weeksRaw)) : 10;
    const result = await getWeeklyConformityRate(shopId, weeks);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/admin/conformity/weekly?weeks=10 - taux de conformité agrégé, semaine par
// semaine, sur PLUSIEURS magasins (demande du 05/10/2026 : "l'admin doit pouvoir afficher pour tous
// les magasins et voir l'évolution") — ADMIN = tous les magasins, SUPERVISOR = son périmètre
// uniquement. Distincte de /conformity/weekly ci-dessus (un seul magasin, via resolveShopId).
router.get('/admin/conformity/weekly', requireAdminOrSupervisor, async (req, res) => {
  try {
    const shopIdFilter = await getAccessibleShopIds(req);
    const weeksRaw = parseInt(req.query.weeks, 10);
    const weeks = Number.isFinite(weeksRaw) ? Math.min(26, Math.max(4, weeksRaw)) : 10;
    const result = await getWeeklyConformityRate(shopIdFilter, weeks);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/stockout-rate - taux de rupture (articles déjà en rupture au moment de la
// génération, sur les propositions validées)
// RÉÉCRIT le 23/10/2026 (demande explicite : "Taux de rupture de stock: du jour" — doit refléter la
// MÊME période que le filtre du Tableau de bord, pas un état figé indépendant) — réutilise
// getDashboardSummary (stockoutEpisodeService.js), la même fonction déjà utilisée par la page
// Ruptures de stock elle-même en mode période, pour renvoyer EXACTEMENT le même chiffre
// (ruptureRatioPct) que cette page pour la période choisie. Sans start/end (rétrocompatibilité),
// retombe sur l'ancien calcul getStockoutRate (basé sur les propositions validées).
router.get('/stockout-rate', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    if (req.query.start && req.query.end) {
      const summary = await getDashboardSummary(shopId, { start: req.query.start, end: req.query.end });
      return res.json({
        success: true,
        data: {
          rate: summary.ruptureRatioPct !== null ? summary.ruptureRatioPct / 100 : null,
          stockoutLines: summary.openCount,
          totalLines: summary.totalOrderableArticles,
        },
      });
    }
    const result = await getStockoutRate(shopId);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/stockout-episodes - module Ruptures (cf. rupture.md) : épisodes en cours,
// durée, cause diagnostiquée (sans données Cyrus, cf. stockoutEpisodeService.js) et pertes estimées.
// start/end optionnels (demande explicite du 20/10/2026 : "quand je fait un filtre il doit etre
// appliqué sur tout") — passés tels quels à getDashboardSummary, qui bascule alors en mode période
// (ruptures actives pendant [start, end] au lieu de "encore ouvertes maintenant"). Sans ces deux
// paramètres, comportement inchangé (état courant).
router.get('/stockout-episodes', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const { start, end } = req.query;
    const result = await getDashboardSummary(shopId, { start, end });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Périmètre magasins pour le rapport Surstock (demande explicite du 21/10/2026 : "qui a le magasin
// doit avoir le droit de voir les article sur surstok" — jusque-là réservé aux comptes
// ADMIN/SUPERVISOR, un compte mono-magasin (Rayonniste/Chef de rayon/Directeur) recevait un 403
// alors qu'il devrait voir le surstock de SON PROPRE magasin, sans comparaison avec les autres).
// ADMIN/SUPERVISOR : périmètre habituel (getAccessibleShopIds). Rôle mono-magasin : toujours
// cantonné à req.user.rposShopId, jamais un ?shop= arbitraire (même cloisonnement que
// resolveShopId ailleurs dans ce fichier).
async function resolveOverstockShopFilter(req) {
  if (SINGLE_SHOP_ROLES.has(req.user.role)) {
    return req.user.rposShopId ? [req.user.rposShopId] : [];
  }
  return getAccessibleShopIds(req);
}

// GET /api/reassort/overstock-report?minWeeksOfCoverage=&start=&end=&shops=id1,id2 - page Surstock
// (demande explicite du 21/10/2026 : "sortir pour les magasins chaque magasin les articles en
// surstock", "identifier les articles que les magasins ont en commun en surstock", "sortir la
// casse de ces articles sur les 3 dernières mois"). minWeeksOfCoverage réglable depuis la page
// (défaut 2 semaines, cf. overstockReportService.js — le seuil chatbot de 6 semaines a été jugé
// trop élevé). start/end optionnels (demande explicite : "si moi meme je veux le surstok sur une
// periode comment je peux faire le filtre") : sans eux, snapshot de la dernière proposition par
// magasin ; avec eux, analyse sur la période choisie (ajoute aussi persistentArticles, "toujours en
// surstock"). shops optionnel (demande explicite : "donne la possiblité de prendre un ou plusieur
// magasin") : restreint encore le périmètre déjà accessible au compte à une sélection précise de
// magasins, jamais un moyen d'élargir l'accès au-delà de ce que le rôle autorise déjà.
// Résout shopIdFilter (périmètre + ?shops= choisi par l'utilisateur) et tente de servir un snapshot
// précalculé pour cette requête — extrait de /overstock-report le 21/10/2026 pour être partagé avec
// /overstock-report/by-shop (pagination serveur du tableau "Par magasin"), qui a besoin de la même
// détection de cache sans dupliquer cette logique. Retourne { shopIdFilter, cachedFullReport } :
// cachedFullReport est le rapport COMPLET (jamais paginé) si un snapshot a pu être servi, sinon null
// (l'appelant doit alors calculer en direct via getOverstockReport).
async function resolveOverstockShopFilterAndCache(req) {
  let shopIdFilter = await resolveOverstockShopFilter(req);
  if (req.query.shops) {
    const requested = String(req.query.shops).split(',').map((s) => s.trim()).filter(Boolean);
    // Intersection avec le périmètre déjà autorisé, jamais une extension : un ADMIN (shopIdFilter
    // === null, aucune restriction) peut choisir n'importe lequel des `requested` ; un
    // SUPERVISOR/mono-magasin ne peut sélectionner que parmi ce qu'il a déjà le droit de voir.
    shopIdFilter = shopIdFilter === null ? requested : shopIdFilter.filter((id) => requested.includes(id));
  }
  const minWeeksOfCoverage = req.query.minWeeksOfCoverage ? Number(req.query.minWeeksOfCoverage) : undefined;
  const { start, end } = req.query;

  // Vue par défaut (aucune période, seuil par défaut ou non précisé) : lit le snapshot précalculé
  // par overstockReportSnapshotJob.js au lieu de recalculer en direct (demande explicite du
  // 21/10/2026 : "il charge trop pourqhoi ? il fait les calcule quand j'actualise ?" — le calcul
  // isolé est rapide, ~0.6s mesuré, mais ralentit fortement en concurrence avec les jobs de
  // synchro RPOS qui saturent le pool de connexions DB au même moment). Tout seuil personnalisé ou
  // toute période retombe sur le calcul en direct, inchangé.
  const isDefaultView = !start && !end && (minWeeksOfCoverage === undefined || minWeeksOfCoverage === DEFAULT_MIN_WEEKS_OF_COVERAGE);
  if (isDefaultView) {
    const cached = await getCachedDefaultOverstockReport(shopIdFilter, OVERSTOCK_REPORT_CACHE_KEY);
    if (cached) return { shopIdFilter, minWeeksOfCoverage, start, end, cachedFullReport: cached };
    // Pas encore de snapshot (job jamais exécuté, ex: tout juste déployé) : calcul en direct
    // exceptionnel, le prochain passage du job remettra la vue par défaut sur le chemin rapide.
  }

  // Vue "3 derniers mois" (demande explicite du 21/10/2026 : devenue le mode de chargement PAR
  // DÉFAUT de la page Surstock — "il faut affiché la courbe apres une analyser qui fait par
  // defaut sur 3mois") : lit elle aussi un snapshot précalculé plutôt que de recalculer en
  // direct, qui a atteint 56-97s en prod sur ~51 magasins × 90 jours (observé le 21/10/2026,
  // concurrence avec les jobs de synchro RPOS + volume de lignes à parcourir). Tolérance de
  // correspondance plutôt qu'une égalité stricte sur les dates ISO : le snapshot est calculé "il
  // y a jusqu'à 1h" (fréquence du job) par "maintenant" côté job, pas par le timestamp exact de
  // CETTE requête.
  //
  // BUG CORRIGÉ le 21/10/2026 (observé en prod : 97s malgré ce correctif, le cache n'était jamais
  // servi) : le frontend envoie end=periodEnd+'T23:59:59' (OverstockReport.tsx), donc `end` tombe
  // systématiquement en FIN de journée — en avance de plusieurs heures sur "maintenant" selon
  // l'heure du jour (ex: requête à 18h40, end=23:59:59 du même jour → en avance de 5h19). La
  // première version de cette tolérance (`endAgeHours >= -1`) rejetait donc presque toujours la
  // vue par défaut du frontend, qui retombait alors systématiquement sur le calcul en direct.
  // Élargi à une journée entière d'avance (24h), largement suffisant pour couvrir ce décalage
  // "fin de journée" sans risquer de confondre avec une vraie période future choisie par
  // l'utilisateur (qui, elle, aurait un `start` tout aussi décalé — testé via spanDays ci-dessous).
  if (!isDefaultView && start && end && (minWeeksOfCoverage === undefined || minWeeksOfCoverage === DEFAULT_MIN_WEEKS_OF_COVERAGE)) {
    const startMs = new Date(start).getTime();
    const endMs = new Date(end).getTime();
    const spanDays = (endMs - startMs) / (24 * 60 * 60 * 1000);
    const endAgeHours = (Date.now() - endMs) / (60 * 60 * 1000);
    const isDefault90dView = Math.abs(spanDays - OVERSTOCK_REPORT_PERIOD_90D_DAYS) <= 1 && endAgeHours >= -24 && endAgeHours <= 24;
    if (isDefault90dView) {
      const cached = await getCachedDefaultOverstockReport(shopIdFilter, OVERSTOCK_REPORT_PERIOD_90D_CACHE_KEY);
      if (cached) return { shopIdFilter, minWeeksOfCoverage, start, end, cachedFullReport: cached };
    }
  }

  return { shopIdFilter, minWeeksOfCoverage, start, end, cachedFullReport: null };
}

router.get('/overstock-report', async (req, res) => {
  try {
    const { shopIdFilter, minWeeksOfCoverage, start, end, cachedFullReport } = await resolveOverstockShopFilterAndCache(req);
    if (cachedFullReport) {
      return res.json({ success: true, data: cachedFullReport });
    }
    const result = await getOverstockReport(shopIdFilter, { minWeeksOfCoverage, start, end });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/overstock-report/by-shop - page filtrée/triée du tableau "Par magasin" de la
// page Surstock, SANS jamais transférer le rapport complet au frontend (demande explicite du
// 21/10/2026 : "ca prend au moins 10s pour affiché c'est normal ?" — 38922 lignes mesurées en prod,
// ~40-50 Mo de JSON transférés et rendus en entier côté client à chaque chargement, la pagination
// visuelle n'agissant qu'APRÈS réception complète). Réutilise le même snapshot/calcul que
// /overstock-report (jamais un second calcul), filtre/trie/pagine EN MÉMOIRE côté serveur, et ne
// renvoie que la page demandée. Portée volontairement limitée à "Par magasin" : les onglets
// "Surstock commun" et "Toujours en surstock" restent sur l'ancien chemin pour l'instant.
router.get('/overstock-report/by-shop', async (req, res) => {
  try {
    const { shopIdFilter, minWeeksOfCoverage, start, end, cachedFullReport } = await resolveOverstockShopFilterAndCache(req);

    // ?all=true (demande explicite du 21/10/2026 : "quand je clique sur le bouton export iil doit
    // me dire je veux le nombre actuel sur la vue ou tout") — utilisé pour l'export CSV "toutes les
    // lignes filtrées", qui n'a pas de sens plafonné à la page affichée à l'écran. Filtres/tri
    // restent appliqués normalement, seule la pagination est contournée.
    const exportAll = req.query.all === 'true';
    const page = req.query.page ? Math.max(1, Number(req.query.page)) : 1;
    const pageSize = exportAll ? Number.MAX_SAFE_INTEGER : (req.query.pageSize ? Math.min(200, Math.max(1, Number(req.query.pageSize))) : 10);
    const search = req.query.search ? String(req.query.search) : undefined;
    const shopIds = req.query.shops ? String(req.query.shops).split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const sortField = req.query.sortField ? String(req.query.sortField) : undefined;
    const sortDir = req.query.sortDir === 'asc' ? 'asc' : 'desc';
    const scrapOnly = req.query.scrapOnly === 'true';
    // rangeFilters attendu en JSON encodé (ex: {"stock":{"min":"5","max":""},...}) — un seul query
    // param plutôt que d'en multiplier un par métrique, plus simple à construire côté frontend
    // depuis l'objet rangeFilters déjà existant.
    let rangeFilters;
    if (req.query.rangeFilters) {
      try {
        rangeFilters = JSON.parse(String(req.query.rangeFilters));
      } catch {
        return res.status(400).json({ success: false, message: 'Paramètre rangeFilters invalide (JSON attendu).' });
      }
    }

    const result = await getOverstockByShopPage(shopIdFilter, {
      minWeeksOfCoverage, start, end, cachedFullReport,
      page, pageSize, search, shopIds, sortField, sortDir, rangeFilters, scrapOnly,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/overstock-report/availability - étendue réelle de l'historique de propositions
// disponible (demande explicite du 21/10/2026 : "on doit me dire j'ai des donner de quel periode...
// si je clique de 10/10/2026 alors que les donner commence de 12 le 10 doit etre grisé") — pour que
// le sélecteur de période de la page Surstock désactive les dates antérieures aux données réelles
// plutôt que de laisser l'utilisateur choisir une fenêtre vide.
router.get('/overstock-report/availability', async (req, res) => {
  try {
    const shopIdFilter = await resolveOverstockShopFilter(req);
    const result = await getOverstockDataAvailability(shopIdFilter);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Résout le périmètre magasins (ADMIN/SUPERVISOR/mono-magasin) PUIS restreint encore à ?shops=
// quand fourni — même raisonnement que resolveOverstockShopFilterAndCache (intersection avec le
// périmètre déjà autorisé, jamais une extension). BUG CORRIGÉ le 24/10/2026 (signalé : "je suis
// dans un magasin il ne dois pas me donner pour tout les mag... je dois voir pour un seul magasin")
// : les 3 routes de détail article ci-dessous (scrap/sales/end-of-life) ignoraient le magasin actif
// de la topbar et retombaient sur le périmètre COMPLET du compte — incohérent avec la page Surstock
// elle-même, mono-magasin depuis la refonte du 23/10/2026.
function applyShopsQueryFilter(shopIdFilter, req) {
  if (!req.query.shops) return shopIdFilter;
  const requested = String(req.query.shops).split(',').map((s) => s.trim()).filter(Boolean);
  return shopIdFilter === null ? requested : shopIdFilter.filter((id) => requested.includes(id));
}

// GET /api/reassort/overstock-report/scrap-detail?ean=&lookbackDays=&shops= - page détail casse
// d'un article en surstock (demande explicite du 21/10/2026 : "quand je clique sur l'article je
// peux avoir ca... tout les casse les quantité, la date et autre") — chaque mouvement de casse
// individuel sur la fenêtre demandée, restreint au magasin actif (?shops=) dans le périmètre
// accessible au compte (ADMIN/SUPERVISOR : leur périmètre habituel ; compte mono-magasin : son seul
// magasin, ?shops= alors sans effet).
router.get('/overstock-report/scrap-detail', async (req, res) => {
  try {
    const shopIdFilter = applyShopsQueryFilter(await resolveOverstockShopFilter(req), req);
    const { ean } = req.query;
    if (!ean) {
      return res.status(400).json({ success: false, message: 'Paramètre ean requis.' });
    }
    const lookbackDays = req.query.lookbackDays ? Number(req.query.lookbackDays) : undefined;
    const typeLabels = req.query.typeLabels ? String(req.query.typeLabels).split(',').filter(Boolean) : undefined;
    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
    const result = await getScrapDetailForArticle(shopIdFilter, String(ean), { lookbackDays, typeLabels, startDate, endDate });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/overstock-report/sales-detail?ean=&lookbackDays=&shops= - détail des VENTES
// d'un article en surstock (demande explicite du 24/10/2026 : "quand je clique il doit me donner
// les movement de vente,casse,dvl sur larticle") — même périmètre/fenêtre que scrap-detail ci-dessus.
router.get('/overstock-report/sales-detail', async (req, res) => {
  try {
    const shopIdFilter = applyShopsQueryFilter(await resolveOverstockShopFilter(req), req);
    const { ean } = req.query;
    if (!ean) {
      return res.status(400).json({ success: false, message: 'Paramètre ean requis.' });
    }
    const lookbackDays = req.query.lookbackDays ? Number(req.query.lookbackDays) : undefined;
    const startDate = req.query.startDate ? String(req.query.startDate) : undefined;
    const endDate = req.query.endDate ? String(req.query.endDate) : undefined;
    const result = await getSalesDetailForArticle(shopIdFilter, String(ean), { lookbackDays, startDate, endDate });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/overstock-report/end-of-life-detail?ean=&shops= - fiches DLV ACTUELLES d'un
// article en surstock (demande explicite du 24/10/2026, même besoin que sales-detail ci-dessus) —
// état présent, pas de fenêtre de dates (cf. getEndOfLifeDetailForArticle).
router.get('/overstock-report/end-of-life-detail', async (req, res) => {
  try {
    const shopIdFilter = applyShopsQueryFilter(await resolveOverstockShopFilter(req), req);
    const { ean } = req.query;
    if (!ean) {
      return res.status(400).json({ success: false, message: 'Paramètre ean requis.' });
    }
    const result = await getEndOfLifeDetailForArticle(shopIdFilter, String(ean));
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/scrap-report?lookbackDays=&shops= - page Casse (demande explicite du
// 21/10/2026 : "les casse des article on doit voir un bouton sur la sidebare") — TOUS les articles
// ayant eu de la casse sur la période, qu'ils soient en surstock ou non (contrairement à la casse
// déjà présente dans Surstock, limitée aux articles déjà identifiés en surstock). Même périmètre
// magasins que /overstock-report (ADMIN/SUPERVISOR/mono-magasin), même raisonnement de
// resolveOverstockShopFilter.
// BUG CORRIGÉ le 28/10/2026 (signalé : "ca ne doit pas etre multi magasin... corrige comme les
// autre") — shopIdFilter ignorait totalement un ?shops= envoyé par le frontend, contrairement à
// resolveOverstockShopFilterAndCache utilisé par /overstock-report : un ADMIN/SUPERVISOR voyait
// systématiquement TOUT le réseau (38 magasins) même avec un magasin précis sélectionné dans la
// topbar, alors que Surstock/Ruptures filtrent déjà correctement sur le magasin actif depuis le
// 23/10/2026. Même intersection shops/périmètre que resolveOverstockShopFilterAndCache : jamais une
// extension au-delà de ce que le rôle autorise déjà, seulement une restriction.
router.get('/scrap-report', async (req, res) => {
  try {
    let shopIdFilter = await resolveOverstockShopFilter(req);
    if (req.query.shops) {
      const requested = String(req.query.shops).split(',').map((s) => s.trim()).filter(Boolean);
      shopIdFilter = shopIdFilter === null ? requested : shopIdFilter.filter((id) => requested.includes(id));
    }
    const lookbackDays = req.query.lookbackDays ? Number(req.query.lookbackDays) : undefined;
    // typeLabels optionnel (demande explicite du 21/10/2026 : "je veux qui tu affiche les type de
    // mouvement pour les casse et tu me donne... et quand c'est visible sur le UI on peux les
    // choisir") — CSV de libellés exacts cochés par l'utilisateur ; sans ce paramètre, retombe sur
    // la liste de mots-clés par défaut (cf. scrapReportService.js).
    const typeLabels = req.query.typeLabels ? String(req.query.typeLabels).split(',').filter(Boolean) : undefined;
    const result = await getScrapOverview(shopIdFilter, { lookbackDays, typeLabels });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/scrap-report/movement-types?lookbackDays=&shops= - liste tous les types de
// mouvement distincts vus sur la période pour le périmètre magasins accessible (demande explicite
// du 21/10/2026 : "met un litre pour affiche ses donner du filtre") — peuple le sélecteur de types
// sur la page Casse, jamais présélectionnée par mots-clés côté UI (isDefaultScrapType n'indique
// qu'une suggestion visuelle, l'utilisateur garde la main complète sur la sélection).
// ?shops= appliqué comme sur /scrap-report ci-dessus (correctif du 28/10/2026) : sans lui, la liste
// de types restait calculée sur tout le réseau même une fois le tableau filtré sur un magasin.
router.get('/scrap-report/movement-types', async (req, res) => {
  try {
    let shopIdFilter = await resolveOverstockShopFilter(req);
    if (req.query.shops) {
      const requested = String(req.query.shops).split(',').map((s) => s.trim()).filter(Boolean);
      shopIdFilter = shopIdFilter === null ? requested : shopIdFilter.filter((id) => requested.includes(id));
    }
    const lookbackDays = req.query.lookbackDays ? Number(req.query.lookbackDays) : undefined;
    const result = await getMovementTypes(shopIdFilter, { lookbackDays });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/stockout-episodes/all-shops - module Ruptures, vue réseau (spec rupture.md
// §2, 16/10/2026) : une ligne-résumé par magasin du périmètre accessible (ADMIN = tous, SUPERVISOR
// = son périmètre), même raisonnement que /admin/conformity/weekly ci-dessus.
router.get('/stockout-episodes/all-shops', requireAdminOrSupervisor, async (req, res) => {
  try {
    const shopIdFilter = await getAccessibleShopIds(req);
    const { start, end } = req.query;
    const result = await getDashboardSummaryAllShops(shopIdFilter, { start, end });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/stockout-episodes/by-sector - module Ruptures, 1er niveau de la navigation
// Secteur → Rayon → Articles (identique à Proposition de commande, demande du 16/10/2026). Placées
// AVANT /stockout-episodes/:id ci-dessous — sinon Express interpréterait ces chemins comme un :id.
router.get('/stockout-episodes/by-sector', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const { start, end } = req.query;
    const result = await getDashboardSummaryBySector(shopId, { start, end });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/stockout-episodes/by-department?sector=... - 2e niveau (rayons d'un secteur
// donné). `sector` optionnel : omis = tous les rayons du magasin (comportement d'origine, encore
// utilisé par l'ancien onglet "Par rayon" avant sa fusion dans cette navigation hiérarchique).
router.get('/stockout-episodes/by-department', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const sector = typeof req.query.sector === 'string' ? req.query.sector : undefined;
    const { start, end } = req.query;
    const result = await getDashboardSummaryByDepartment(shopId, { sector, start, end });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/stockout-episodes/trend?start=&end= - module Ruptures, évolution du nombre de
// ruptures en cours jour par jour sur une période (demande du 16/10/2026 : même niveau de détail
// visuel que TableauDeBord.tsx, courbe de tendance). Placée AVANT /stockout-episodes/:id.
//
// start/end optionnels ajoutés le 18/10/2026 (demande explicite : "le filtre doit etre pour tout a
// emme temps... ne donne pas un filtre par detaut qui n'est pas modifialbe comme Ruptures en cours
// — 30 derniers jours") — remplace la fenêtre fixe à 30 jours : un seul sélecteur de période côté
// page pilote désormais ce graphe ET l'analyse des pertes (period-summary/period-analysis
// ci-dessous), plutôt que deux systèmes de dates séparés et incohérents. Sans start/end, retombe
// sur le défaut historique (30 derniers jours) pour ne jamais casser un appel existant.
router.get('/stockout-episodes/trend', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const { start, end } = req.query;
    let days = 30;
    if (start && end) {
      const diffMs = new Date(end).getTime() - new Date(start).getTime();
      days = Math.max(1, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
    }
    const result = await getStockoutTrend(shopId, { days });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/stockout-episodes/period-summary?start=&end= - module Ruptures, synthèse des
// pertes sur une période personnalisée comparée au CA réellement réalisé par le magasin sur la même
// période (demande explicite du 18/10/2026 : "filtre sur une periode personalisé pour voir sur
// quel periode les perte que j'ai eu... vs mon CA du mag"). Placée AVANT /stockout-episodes/:id.
router.get('/stockout-episodes/period-summary', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ success: false, message: 'Paramètres start et end (dates) requis.' });
    }

    // Précalcul nocturne (demande explicite du 19/10/2026 : "l'analyse ne doit pas ce fait a
    // achaque actualisation de la page il doit etre fait pas defaut et stocke en base") — la période
    // PAR DÉFAUT (30 derniers jours glissants) est servie instantanément depuis
    // StockoutPeriodSummarySnapshot plutôt que recalculée à chaque chargement. Toute autre période
    // choisie par l'utilisateur (confirmé explicitement : "si je met 1an il doit me donner si je
    // met 1 jour il dois affiché aussi") continue d'être calculée en direct ci-dessous — on ne
    // sert le snapshot QUE si la fenêtre demandée correspond bien aux 30 derniers jours (± 1 jour de
    // tolérance sur la durée, et "end" doit tomber dans les dernières 24h, sinon ce n'est pas une
    // vraie fenêtre "glissante jusqu'à maintenant" mais une période choisie délibérément dans le passé).
    const startDate = new Date(start);
    const endDate = new Date(end);
    const requestedDays = (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
    const endIsRecent = Date.now() - endDate.getTime() < 24 * 60 * 60 * 1000;
    const matchesDefaultPeriod = Math.abs(requestedDays - STOCKOUT_PERIOD_SNAPSHOT_DAYS) <= 1 && endIsRecent;

    if (matchesDefaultPeriod) {
      const snapshot = await prisma.stockoutPeriodSummarySnapshot.findUnique({ where: { rposShopId: shopId } });
      if (snapshot) {
        const lossRatioPct = snapshot.shopRevenueExclTax > 0 ? Math.round((snapshot.totalCaPerdu / snapshot.shopRevenueExclTax) * 1000) / 10 : null;
        return res.json({
          success: true,
          data: {
            found: true,
            period: { startDate: start, endDate: end },
            totalCaPerdu: Math.round(snapshot.totalCaPerdu),
            totalQtyPerdue: Math.round(snapshot.totalQtyPerdue),
            episodeCount: snapshot.episodeCount,
            shopRevenueExclTax: Math.round(snapshot.shopRevenueExclTax),
            lossRatioPct,
            departmentBreakdown: JSON.parse(snapshot.departmentBreakdownJson),
            precomputedAt: snapshot.computedAt,
          },
        });
      }
      // Pas encore de snapshot pour ce magasin (premier passage du job pas encore effectué) —
      // repli sur le calcul en direct, jamais une erreur bloquante.
    }

    const result = await getPeriodLossSummary(shopId, { startDate: start, endDate: end });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/stockout-episodes/period-analysis - module Ruptures, analyse IA À LA DEMANDE
// (bouton "Analyser", jamais automatique) de la synthèse de pertes sur une période — body: { start,
// end }. Recalcule la synthèse côté serveur (jamais les chiffres envoyés par le client) avant de les
// transmettre à l'IA, pour ne jamais faire interpréter par le LLM des chiffres non vérifiés.
router.post('/stockout-episodes/period-analysis', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const { start, end } = req.body || {};
    if (!start || !end) {
      return res.status(400).json({ success: false, message: 'Paramètres start et end (dates) requis.' });
    }
    const shop = await prisma.shop.findUnique({ where: { rposShopId: shopId }, select: { name: true, reference: true } });
    const summary = await getPeriodLossSummary(shopId, { startDate: start, endDate: end });
    const analysis = await analyzePeriodLoss(shop?.name || 'Magasin', shop?.reference || shopId, summary);
    res.json({ success: true, data: { ...analysis, summary } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/reassort/stockout-episodes/period-analysis-stream - variante streamée (SSE) de la route
// ci-dessus (demande explicite du 22/10/2026 : "l'analyse IA dure trop ici" — bouton "Analyse en
// cours..." figé 30s à 1min sans aucun retour visuel) : le texte brut généré par l'IA s'affiche au
// fur et à mesure côté frontend, puis l'événement "done" porte le résultat structuré final (même
// fusion avec les chiffres serveur que la route non-streamée). Même convention SSE que
// ai-analyze-article-stream (routes/reassort/ai.js) : POST + fetch().body.getReader() côté client,
// jamais EventSource natif (pas de support POST/Authorization custom).
router.post('/stockout-episodes/period-analysis-stream', async (req, res) => {
  const shopId = resolveShopId(req);
  if (!shopId) {
    return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
  }
  const { start, end } = req.body || {};
  if (!start || !end) {
    return res.status(400).json({ success: false, message: 'Paramètres start et end (dates) requis.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const shop = await prisma.shop.findUnique({ where: { rposShopId: shopId }, select: { name: true, reference: true } });
    const summary = await getPeriodLossSummary(shopId, { startDate: start, endDate: end });
    const analysis = await analyzePeriodLoss(shop?.name || 'Magasin', shop?.reference || shopId, summary, (chunk) => send('chunk', { text: chunk }));
    send('done', { ...analysis, summary });
    res.end();
  } catch (error) {
    send('error', { message: error.message });
    res.end();
  }
});

// POST /api/reassort/stockout-episodes/:id/analyze - module Ruptures, analyse IA À LA DEMANDE
// (bouton, jamais automatique) de la section "Détection / Commande / Prise en charge" d'UN épisode
// précis (demande explicite du 18/10/2026 : "cette partie aussi on doit avoir une analyse Ia").
// Recalcule le détail côté serveur avant de le transmettre à l'IA — jamais les chiffres envoyés par
// le client. Placée AVANT /stockout-episodes/:id ci-dessous (piège Express déjà documenté : un
// chemin plus spécifique doit toujours précéder :id, sinon Express le confondrait avec un id).
router.post('/stockout-episodes/:id/analyze', async (req, res) => {
  try {
    const episode = await prisma.stockoutEpisode.findUnique({ where: { id: req.params.id }, select: { rposShopId: true } });
    if (!episode) return res.status(404).json({ success: false, message: "Rupture d'article introuvable." });

    const shopIdFilter = await getAccessibleShopIds(req);
    const ownShopId = resolveShopId(req);
    const allowed = shopIdFilter === null ? true : shopIdFilter.includes(episode.rposShopId);
    if (!allowed && episode.rposShopId !== ownShopId) {
      return res.status(403).json({ success: false, message: 'Accès refusé à ce magasin.' });
    }

    const detail = await getEpisodeDetail(req.params.id);
    if (!detail.found) return res.status(404).json({ success: false, message: "Rupture d'article introuvable." });
    const analysis = await analyzeEpisode(detail);
    res.json({ success: true, data: analysis });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/stockout-episodes/:id - module Ruptures, fiche détaillée d'un épisode (spec
// rupture.md §3-§5, 16/10/2026) : mouvements de stock, ventes, commande associée et chronologie.
// Vérifie que l'épisode appartient à un magasin accessible avant de le renvoyer (ADMIN = tous,
// SUPERVISOR = son périmètre, autre rôle = son propre magasin) — même raisonnement que
// isEanInUserScope ci-dessus, pour empêcher un accès à un épisode d'un autre magasin via son id.
router.get('/stockout-episodes/:id', async (req, res) => {
  try {
    const episode = await prisma.stockoutEpisode.findUnique({ where: { id: req.params.id }, select: { rposShopId: true } });
    if (!episode) return res.status(404).json({ success: false, message: "Rupture d'article introuvable." });

    const shopIdFilter = await getAccessibleShopIds(req);
    const ownShopId = resolveShopId(req);
    const allowed = shopIdFilter === null ? true : shopIdFilter.includes(episode.rposShopId);
    if (!allowed && episode.rposShopId !== ownShopId) {
      return res.status(403).json({ success: false, message: 'Accès refusé à ce magasin.' });
    }

    const result = await getEpisodeDetail(req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/overstock-rate - taux de surstock (quantité commandée bien au-delà du besoin
// théorique, sur les propositions validées)
// RÉÉCRIT le 23/10/2026 (demande explicite : "Taux de surstock: tu dois affiché les surtok sur ses
// article tu vois ?") — l'ancien calcul (getOverstockRate, proposalService.js) mesurait la
// proportion de COMMANDES VALIDÉES en sur-quantité par rapport au besoin théorique (une mesure de
// correction manuelle excessive), pas le nombre d'articles RÉELLEMENT en surstock aujourd'hui.
// Réutilise désormais la même logique que la page Surstock elle-même (getOverstockByShop,
// overstockReportService.js : stock actuel / vente moyenne ≥ seuil de semaines de couverture) pour
// que ce KPI affiche le même chiffre que la page dédiée, pas un indicateur différent sous un nom
// similaire. Dénominateur (totalLines) = articles commandables du magasin (ProductCache.orderable),
// même convention que ruptureRatioPct dans stockoutEpisodeService.js.
// start/end optionnels (demande explicite du 23/10/2026 : "Taux de surstock: du jour" — doit
// refléter la MÊME période que le filtre du Tableau de bord). Avec start/end, réutilise
// getOverstockOverPeriod (overstockReportService.js), la même fonction déjà utilisée par la page
// Surstock elle-même en mode période — même chiffre (articleCount) que cette page pour la période
// choisie. Sans start/end (rétrocompatibilité), retombe sur getOverstockByShop (état "maintenant").
router.get('/overstock-rate', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const [report, totalOrderableArticles] = await Promise.all([
      req.query.start && req.query.end
        ? getOverstockOverPeriod([shopId], { minWeeksOfCoverage: DEFAULT_MIN_WEEKS_OF_COVERAGE, start: req.query.start, end: req.query.end })
        : getOverstockByShop([shopId], { minWeeksOfCoverage: DEFAULT_MIN_WEEKS_OF_COVERAGE }),
      prisma.productCache.count({ where: { rposShopId: shopId, orderable: true } }),
    ]);
    const overstockLines = report.found ? report.articleCount : 0;
    const result = {
      rate: totalOrderableArticles > 0 ? overstockLines / totalOrderableArticles : null,
      overstockLines,
      totalLines: totalOrderableArticles,
    };
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/shadow-ai-report - Mode Simulation : sur les lignes où l'humain a corrigé la
// quantité proposée par l'IA, qui avait raison au vu des ventes réellement constatées ensuite ?
// Sert à juger objectivement, sur l'historique réel du magasin, si l'IA est assez fiable pour
// envisager une automatisation sans validation humaine (évolution "Mode Auto", pas encore construite).
router.get('/shadow-ai-report', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const result = await getShadowAiReport(shopId);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Shadow AI report error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/ai-decision-log - journal consultable des décisions IA (raisonnement + action
// par article, historique dans le temps), filtrable par article/action/période. Lit uniquement des
// données déjà persistées à la génération (ProposalLine.aiReasoning/aiAction), ne recalcule rien.
router.get('/ai-decision-log', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const { ean, action, from, to } = req.query;
    const result = await getAiDecisionLog(shopId, { ean, action, from, to });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('AI decision log error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/admin/today-proposals - magasins ayant une proposition générée aujourd'hui
// (ADMIN = tous les magasins, SUPERVISOR = son périmètre uniquement — demande du 05/10/2026,
// auparavant réservé ADMIN strict, bloquait les SUPERVISOR avec un 403. Tableau de bord vue
// multi-magasins, 30/09/2026).
router.get('/admin/today-proposals', requireAdminOrSupervisor, async (req, res) => {
  try {
    const shopIdFilter = await getAccessibleShopIds(req);
    const result = await getTodayProposalShops(shopIdFilter);
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('Today proposal shops error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/admin/dashboard - vue globale multi-magasins (ADMIN = tous les magasins,
// SUPERVISOR = son périmètre uniquement — mêmes raisons que ci-dessus. readme §32)
router.get('/admin/dashboard', requireAdminOrSupervisor, async (req, res) => {
  try {
    const shopIdFilter = await getAccessibleShopIds(req);
    const result = await getAdminDashboard(shopIdFilter);
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
    if (req.query.ean && !(await isEanInUserScope(req, shopId, req.query.ean))) {
      return res.status(403).json({ success: false, message: 'Cet article n\'est pas dans votre périmètre.' });
    }
    const data = await productInsightCache.getProductInsight(posId, shopId, req.params.productId, req.query.ean);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Last-purchase/last-sale error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/product/:productId/proposal-history?ean= - pour un article, l'historique des
// quantités PROPOSÉES (à commander) à chaque génération récente du magasin, avec date/heure, ET la
// quantité déjà VENDUE entre deux générations successives — demande du 15/09/2026 ("un tab en bas
// pour montrer le détail" avec "les date heure" et "les quantités déjà vendues"), distinct de
// l'historique par plan hebdomadaire (weekly-plan/:id/history) qui ne couvre qu'un plan précis.
router.get('/product/:productId/proposal-history', async (req, res) => {
  try {
    const shopId = resolveShopId(req);
    if (!shopId) {
      return res.status(400).json({ success: false, message: 'Aucun magasin assigné à ce compte' });
    }
    const { ean } = req.query;
    if (!ean) {
      return res.status(400).json({ success: false, message: 'ean requis' });
    }

    if (!(await isEanInUserScope(req, shopId, ean))) {
      return res.status(403).json({ success: false, message: 'Cet article n\'est pas dans votre périmètre.' });
    }

    const lines = await prisma.proposalLine.findMany({
      where: { ean, proposal: { rposShopId: shopId } },
      orderBy: { proposal: { generatedAt: 'desc' } },
      take: 20,
      select: {
        quantitySuggested: true,
        quantityValidated: true,
        aiAdjusted: true,
        proposal: { select: { id: true, generatedAt: true, status: true, analysisPeriodStart: true, analysisPeriodEnd: true } },
      },
    });

    const chronological = lines.slice().reverse();
    const history = [];
    for (let i = 0; i < chronological.length; i++) {
      const current = chronological[i];
      const previous = i > 0 ? chronological[i - 1] : null;
      const soldSince = previous
        ? await prisma.salesLine.aggregate({
            where: { ean, rposShopId: shopId, date: { gt: previous.proposal.generatedAt, lte: current.proposal.generatedAt } },
            _sum: { quantity: true },
          })
        : null;
      history.push({
        proposalId: current.proposal.id,
        generatedAt: current.proposal.generatedAt,
        status: current.proposal.status,
        quantitySuggested: current.quantitySuggested,
        quantityValidated: current.quantityValidated,
        aiAdjusted: current.aiAdjusted,
        quantitySoldSincePrevious: soldSince ? (soldSince._sum.quantity || 0) : null,
      });
    }

    res.json({ success: true, data: history });
  } catch (error) {
    console.error('Product proposal-history error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Cache court en mémoire process pour getPendingPlatformOrderedEans (demande du 20/10/2026 :
// "j'ai deja ses donner en local qui son synchroniser non ?"). Dans proposalService.js cet appel
// RPOS est déjà partagé entre des centaines d'articles au sein d'une même génération de
// proposition (coût acceptable car amorti) — mais ici, ouvrir ce panneau pour voir UN SEUL article
// répétait tout le coût (parcourt toutes les commandes plateforme en cours + un appel RPOS par
// commande pour ses lignes) à chaque clic, pour un résultat qui ne change qu'au rythme des
// commandes passées sur la plateforme, pas à chaque seconde.
const PENDING_PLATFORM_ORDERS_CACHE_TTL_MS = 5 * 60 * 1000;
const pendingPlatformOrdersCache = new Map(); // `${posId}:${shopId}` -> { data, cachedAt }

async function getPendingPlatformOrderedEansCached(posId, shopId) {
  const key = `${posId}:${shopId}`;
  const cached = pendingPlatformOrdersCache.get(key);
  if (cached && Date.now() - cached.cachedAt < PENDING_PLATFORM_ORDERS_CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await rpos.getPendingPlatformOrderedEans(posId, shopId);
  pendingPlatformOrdersCache.set(key, { data, cachedAt: Date.now() });
  return data;
}

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
    if (!(await isEanInUserScope(req, shopId, ean))) {
      return res.status(403).json({ success: false, message: 'Cet article n\'est pas dans votre périmètre.' });
    }

    const config = await getConfig(shopId);
    let currentStock;
    let currentOrderedQuantity;
    try {
      // Lu depuis ProductCache (resynchronisé régulièrement par stockoutProductCacheRefreshJob.js
      // et à chaque génération de proposition) plutôt qu'un appel RPOS /api/product/ en direct à
      // chaque ouverture de ce panneau (demande du 20/10/2026 : "j'ai deja ses donner en local qui
      // son synchroniser non ?") — même source que le tableau de la proposition, donc jamais en
      // désaccord avec lui, et nettement plus rapide à afficher.
      const product = await prisma.productCache.findUnique({ where: { rposShopId_ean: { rposShopId: shopId, ean } } });
      if (product) {
        currentStock = Number(product.stock || 0);
        // On n'utilise PAS le compteur RPOS brut product.current_ordered_quantity : comme dans
        // proposalService.processArticle, il accumule indéfiniment des commandes centrales jamais
        // marquées "livrées" côté RPOS et masquerait un vrai besoin de recommander (cf. le
        // commentaire équivalent dans proposalService.js). On recalcule la même quantité "déjà en
        // commande" que le tableau de la proposition (max entre commandes RPOS récentes non
        // livrées et commandes en transit de cette plateforme), pour que ce panneau de détail ne
        // raconte jamais une autre histoire que le tableau principal.
        const ignoreRposStock = !!config.ignoreRposStockInCalculation;
        let rposOrderedQty = 0;
        let quantityInTransit = 0;
        if (!ignoreRposStock) {
          // Les deux appels sont indépendants (l'un lit un cache DB par produit, l'autre un cache
          // mémoire process par magasin) : lancés en parallèle plutôt qu'en série, ce qui domine
          // encore le temps de réponse une fois le stock lu localement ci-dessus.
          const [recentRposOrder, pendingPlatformOrders] = await Promise.all([
            getRecentUndeliveredOrderedQuantityCached(posId, shopId, product.productId, config.recentOrderMaxAgeDays, ignoreRposStock),
            getPendingPlatformOrderedEansCached(posId, shopId),
          ]);
          rposOrderedQty = recentRposOrder.quantity;
          quantityInTransit = pendingPlatformOrders.quantityByEan.get(ean) || 0;
        }
        currentOrderedQuantity = Math.max(rposOrderedQty, quantityInTransit);
      }
    } catch (err) {
      console.error('[product analytics] Échec de lecture du produit:', err.message);
    }

    // Analyse principale et mouvements de stock (casse, cession entre rayons, retour fournisseur...)
    // sont indépendants l'un de l'autre : lancés en parallèle. Le second reste best-effort et ne
    // doit jamais faire échouer le premier si RPOS est indisponible ou si l'article n'a aucun
    // mouvement hors vente/réception (demande du 16/09/2026, à partir de l'écran admin RPOS
    // "Mouvements de stock").
    const [data, stockMoves] = await Promise.all([
      productAnalyticsService.analyzeProduct(posId, shopId, {
        ean,
        productId: req.params.productId,
        dateStart,
        dateEnd,
        safetyStockRatio: config.safetyStockRatio,
        currentStock,
        currentOrderedQuantity,
      }),
      stockMoveAnalysis.getStockMoveSummary(posId, shopId, ean, dateStart, dateEnd).catch((err) => {
        console.error('[product analytics] Échec de lecture des mouvements de stock RPOS:', err.message);
        return null;
      }),
    ]);

    res.json({ success: true, data: { ...data, stockMoves } });
  } catch (error) {
    console.error('Product analytics error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/reassort/config - configuration réassort du magasin de l'utilisateur (seuil Pareto, période, etc.)
module.exports = router;
