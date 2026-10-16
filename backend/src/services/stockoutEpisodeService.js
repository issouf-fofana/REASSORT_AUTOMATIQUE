/**
 * Détection et diagnostic des épisodes de rupture de stock, SANS les données Cyrus (entrepôt) —
 * cf. rupture.md. Le diagnostic est donc une version simplifiée de la grille §5 du document : on ne
 * peut pas distinguer "stock central indisponible" / "non préparé" / "retard transport", ces 3 cas
 * retombent tous sur AMONT_A_PRECISER.
 */
const prisma = require('../utils/prisma');
const { getMovesFromLocal } = require('./stockMoveAnalysisService');

const LOOKBACK_WEEKS = 8;
const MIN_COMPARABLE_WEEKS = 4; // sous ce seuil, estimation trop fragile pour être affichée

/**
 * Ouvre un nouvel épisode pour chaque article passé de stock>0 à stock<=0 depuis le dernier
 * snapshot, et referme (status=RESOLUE) les épisodes EN_COURS dont le stock est redevenu positif.
 * Appelée après chaque capture de snapshot (cf. stockSnapshotJob.js).
 */
async function detectStockoutEpisodes(rposShopId) {
  const openEpisodes = await prisma.stockoutEpisode.findMany({
    where: { rposShopId, status: 'EN_COURS' },
  });
  const openByEan = new Map(openEpisodes.map((e) => [e.ean, e]));

  const latestSnapshots = await prisma.stockSnapshot.findMany({
    where: { rposShopId },
    orderBy: { capturedAt: 'desc' },
    distinct: ['ean'],
  });

  for (const snap of latestSnapshots) {
    const open = openByEan.get(snap.ean);

    if (snap.stock <= 0 && !open) {
      const diagnosis = await diagnoseCause(rposShopId, snap.ean);
      await prisma.stockoutEpisode.create({
        data: {
          rposPosId: snap.rposPosId,
          rposShopId,
          ean: snap.ean,
          label: diagnosis.label || null,
          department: diagnosis.department || null,
          startedAt: snap.capturedAt,
          status: 'EN_COURS',
          causeProposee: diagnosis.cause,
          niveauConfiance: diagnosis.confiance,
          commandeRefUtile: diagnosis.commandeRef || null,
        },
      });
    } else if (snap.stock > 0 && open) {
      const estimation = await estimateLoss(rposShopId, open.ean, open.startedAt, snap.capturedAt);
      await prisma.stockoutEpisode.update({
        where: { id: open.id },
        data: {
          status: 'RESOLUE',
          endedAt: snap.capturedAt,
          qtyPerdueEstimee: estimation.qtyPerdue,
          caPerdueEstime: estimation.caPerdue,
        },
      });
    }
  }
}

/**
 * Diagnostic simplifié (sans Cyrus) : on regarde uniquement si une commande récente couvrant cet
 * article existe, et à quel stade de receptionStatus elle est. Prend la ProposalLine la plus récente
 * pour (shop, ean) comme point d'entrée, puis cherche le ProposalOrder correspondant (même
 * proposalId + department).
 */
async function diagnoseCause(rposShopId, ean) {
  const recentLine = await prisma.proposalLine.findFirst({
    where: { ean, proposal: { rposShopId } },
    orderBy: { proposal: { generatedAt: 'desc' } },
    include: { proposal: true },
  });

  const label = recentLine?.label || null;
  const department = recentLine?.department || null;

  if (!recentLine) {
    return { cause: 'MAGASIN_REASSORT', confiance: 'PROBABLE', label, department };
  }

  const order = await prisma.proposalOrder.findFirst({
    where: { proposalId: recentLine.proposalId, department: recentLine.department || undefined },
    orderBy: { createdAt: 'desc' },
  });

  if (!order) {
    return { cause: 'MAGASIN_REASSORT', confiance: 'PROBABLE', label, department };
  }

  if (order.rposOrderValidated === false || order.status === 'PENDING') {
    return { cause: 'MAGASIN_COMMANDE_NON_VALIDEE', confiance: 'CONFIRMEE', commandeRef: order.id, label, department };
  }

  if (order.receptionStatus === 'EN_ATTENTE_RECEPTION') {
    return { cause: 'AMONT_A_PRECISER', confiance: 'PROBABLE', commandeRef: order.id, label, department };
  }

  if (order.receptionStatus === 'RECUE_ESTIMEE') {
    return { cause: 'ECART_STOCK_RAYON', confiance: 'PROBABLE', commandeRef: order.id, label, department };
  }

  return { cause: 'INDETERMINEE', confiance: 'INDETERMINEE', commandeRef: order.id, label, department };
}

/**
 * Quantité/CA perdus estimés = ventes attendues (moyenne du même jour de semaine sur les
 * LOOKBACK_WEEKS précédentes, hors période de rupture) moins ventes réellement réalisées pendant la
 * rupture. Cf. rupture.md §2.4.
 */
async function estimateLoss(rposShopId, ean, startedAt, endedAt) {
  const durationMs = endedAt.getTime() - startedAt.getTime();
  const durationDays = Math.max(1, Math.ceil(durationMs / (24 * 60 * 60 * 1000)));

  const lookbackStart = new Date(startedAt.getTime() - LOOKBACK_WEEKS * 7 * 24 * 60 * 60 * 1000);
  const comparableSales = await prisma.salesLine.findMany({
    where: { rposShopId, ean, date: { gte: lookbackStart, lt: startedAt } },
    select: { date: true, quantity: true, revenueExclTax: true },
  });

  const targetDow = startedAt.getDay();
  const sameDowSales = comparableSales.filter((s) => s.date.getDay() === targetDow);
  const comparableWeeksCount = new Set(sameDowSales.map((s) => s.date.toISOString().slice(0, 10))).size;

  if (comparableWeeksCount < MIN_COMPARABLE_WEEKS) {
    return { qtyPerdue: null, caPerdue: null };
  }

  const avgDailyQty = sameDowSales.reduce((sum, s) => sum + s.quantity, 0) / comparableWeeksCount;
  const avgDailyRevenue = sameDowSales.reduce((sum, s) => sum + s.revenueExclTax, 0) / comparableWeeksCount;

  const expectedQty = avgDailyQty * durationDays;
  const expectedRevenue = avgDailyRevenue * durationDays;

  const actualSales = await prisma.salesLine.aggregate({
    where: { rposShopId, ean, date: { gte: startedAt, lte: endedAt } },
    _sum: { quantity: true, revenueExclTax: true },
  });
  const actualQty = actualSales._sum.quantity || 0;
  const actualRevenue = actualSales._sum.revenueExclTax || 0;

  const qtyPerdue = Math.max(0, expectedQty - actualQty);
  const caPerdue = Math.max(0, expectedRevenue - actualRevenue);

  return { qtyPerdue, caPerdue };
}

/**
 * Liste les épisodes en cours d'un magasin, pour le dashboard. durationHours calculé à la volée
 * (pas stocké, puisque l'épisode est toujours ouvert).
 */
async function getOpenEpisodes(rposShopId) {
  const episodes = await prisma.stockoutEpisode.findMany({
    where: { rposShopId, status: 'EN_COURS' },
    orderBy: { startedAt: 'asc' },
  });

  const now = new Date();
  return episodes.map((e) => ({
    ...e,
    durationHours: Math.round(((now.getTime() - e.startedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10,
  }));
}

/**
 * Vue d'ensemble pour les KPI du dashboard : nombre de ruptures en cours, durée moyenne, CA perdu
 * cumulé sur les épisodes résolus récemment, répartition des causes.
 */
async function getDashboardSummary(rposShopId, { resolvedLookbackDays = 30 } = {}) {
  const [openEpisodes, resolvedEpisodes] = await Promise.all([
    getOpenEpisodes(rposShopId),
    prisma.stockoutEpisode.findMany({
      where: {
        rposShopId,
        status: 'RESOLUE',
        endedAt: { gte: new Date(Date.now() - resolvedLookbackDays * 24 * 60 * 60 * 1000) },
      },
    }),
  ]);

  const avgDurationHours = openEpisodes.length
    ? openEpisodes.reduce((sum, e) => sum + e.durationHours, 0) / openEpisodes.length
    : 0;

  const totalCaPerdu = resolvedEpisodes.reduce((sum, e) => sum + (e.caPerdueEstime || 0), 0);

  const causeCounts = {};
  for (const e of [...openEpisodes, ...resolvedEpisodes]) {
    causeCounts[e.causeProposee] = (causeCounts[e.causeProposee] || 0) + 1;
  }

  return {
    openCount: openEpisodes.length,
    avgDurationHours: Math.round(avgDurationHours * 10) / 10,
    totalCaPerduEstime: Math.round(totalCaPerdu),
    causeCounts,
    openEpisodes,
  };
}

// Seuil "rupture longue" par défaut, cf. spec §2 "Nombre de ruptures qui dépassent un seuil de
// durée défini" — pas de configuration dédiée pour l'instant (vague 1 : vue réseau), valeur fixe
// raisonnable reprise s'il faut la rendre réglable plus tard.
const LONG_EPISODE_HOURS = 48;

// Causes qui indiquent qu'AUCUNE commande n'a été identifiée pour expliquer la rupture (spec §2 :
// "Nombre de ruptures sans commande de réapprovisionnement identifiée") — distinct de
// MAGASIN_COMMANDE_NON_VALIDEE, où une commande EXISTE mais n'a pas été validée.
const NO_ORDER_CAUSES = new Set(['MAGASIN_REASSORT', 'INDETERMINEE']);

/**
 * Vue réseau (spec rupture.md §2, 16/10/2026) : pour chaque magasin accessible, une ligne-résumé
 * de sa situation de ruptures. Même principe que getStockoutRisksAllShops (chatbotToolsService.js) :
 * itère les magasins du périmètre, agrège, trie par magasin le plus touché en premier.
 */
async function getDashboardSummaryAllShops(allowedShopIds, { resolvedLookbackDays = 30 } = {}) {
  // allowedShopIds === null signifie "pas de restriction" (ADMIN, cf. getAccessibleShopIds dans
  // middleware/auth.js) — distinct d'un tableau vide, qui signifierait "aucun magasin accessible"
  // pour un SUPERVISOR sans périmètre configuré. Même convention que getWeeklyConformityRate.
  if (Array.isArray(allowedShopIds) && !allowedShopIds.length) return { found: false, message: 'Aucun magasin accessible pour ce compte.' };

  const shops = await prisma.shop.findMany({
    where: allowedShopIds !== null ? { rposShopId: { in: allowedShopIds } } : {},
    select: { rposShopId: true, reference: true, name: true },
  });

  const results = [];
  for (const shop of shops) {
    const [openEpisodes, resolvedCount] = await Promise.all([
      prisma.stockoutEpisode.findMany({ where: { rposShopId: shop.rposShopId, status: 'EN_COURS' } }),
      prisma.stockoutEpisode.count({
        where: {
          rposShopId: shop.rposShopId,
          status: 'RESOLUE',
          endedAt: { gte: new Date(Date.now() - resolvedLookbackDays * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);
    if (!openEpisodes.length && !resolvedCount) continue;

    const now = Date.now();
    const durations = openEpisodes.map((e) => (now - e.startedAt.getTime()) / (60 * 60 * 1000));
    const avgDurationHours = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;
    const longEpisodesCount = durations.filter((d) => d >= LONG_EPISODE_HOURS).length;
    const noOrderCount = openEpisodes.filter((e) => NO_ORDER_CAUSES.has(e.causeProposee)).length;

    const resolvedWithLoss = await prisma.stockoutEpisode.findMany({
      where: { rposShopId: shop.rposShopId, status: 'RESOLUE', endedAt: { gte: new Date(now - resolvedLookbackDays * 24 * 60 * 60 * 1000) } },
      select: { caPerdueEstime: true },
    });
    const totalCaPerdu = resolvedWithLoss.reduce((s, e) => s + (e.caPerdueEstime || 0), 0);

    results.push({
      rposShopId: shop.rposShopId,
      shopReference: shop.reference,
      shopName: shop.name,
      openCount: openEpisodes.length,
      totalEpisodesCount: openEpisodes.length + resolvedCount,
      avgDurationHours: Math.round(avgDurationHours * 10) / 10,
      longEpisodesCount,
      noOrderCount,
      totalCaPerduEstime: Math.round(totalCaPerdu),
    });
  }

  results.sort((a, b) => b.openCount - a.openCount);

  if (!results.length) return { found: true, shopCount: 0, message: 'Aucun magasin avec une rupture détectée sur la période.' };
  return {
    found: true,
    shopCount: results.length,
    totalOpenAcrossShops: results.reduce((s, r) => s + r.openCount, 0),
    shops: results,
  };
}

/**
 * Dashboard par rayon (spec rupture.md §7, 16/10/2026) : pour un magasin donné, une ligne-résumé
 * par rayon (ProposalLine.department/StockoutEpisode.department). Même indicateurs que la vue
 * réseau (§2), appliqués au niveau rayon au lieu du niveau magasin — permet d'identifier les rayons
 * les plus exposés. Un seul magasin à la fois (pas de boucle réseau ici), donc agrégation directe en
 * base via groupBy plutôt qu'une boucle JS comme getDashboardSummaryAllShops.
 */
async function getDashboardSummaryByDepartment(rposShopId, { resolvedLookbackDays = 30 } = {}) {
  const now = new Date();
  const resolvedSince = new Date(now.getTime() - resolvedLookbackDays * 24 * 60 * 60 * 1000);

  const [openEpisodes, resolvedEpisodes] = await Promise.all([
    prisma.stockoutEpisode.findMany({ where: { rposShopId, status: 'EN_COURS' } }),
    prisma.stockoutEpisode.findMany({
      where: { rposShopId, status: 'RESOLUE', endedAt: { gte: resolvedSince } },
      select: { department: true, caPerdueEstime: true },
    }),
  ]);

  if (!openEpisodes.length && !resolvedEpisodes.length) {
    return { found: true, departmentCount: 0, message: 'Aucune rupture détectée pour ce magasin sur la période.' };
  }

  // department peut être null (épisode dont l'article n'a jamais été proposé, cf. diagnoseCause) —
  // regroupé sous "Sans rayon" plutôt que silencieusement exclu, pour ne jamais faire disparaître
  // un épisode réel de la vue agrégée.
  const byDept = new Map();
  function getBucket(dept) {
    const key = dept || 'Sans rayon';
    if (!byDept.has(key)) byDept.set(key, { department: key, openEpisodes: [], resolvedCount: 0, totalCaPerdu: 0 });
    return byDept.get(key);
  }

  for (const e of openEpisodes) getBucket(e.department).openEpisodes.push(e);
  for (const e of resolvedEpisodes) {
    const bucket = getBucket(e.department);
    bucket.resolvedCount += 1;
    bucket.totalCaPerdu += e.caPerdueEstime || 0;
  }

  const results = Array.from(byDept.values()).map((bucket) => {
    const durations = bucket.openEpisodes.map((e) => (now.getTime() - e.startedAt.getTime()) / (60 * 60 * 1000));
    const avgDurationHours = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;
    const longEpisodesCount = durations.filter((d) => d >= LONG_EPISODE_HOURS).length;
    const noOrderCount = bucket.openEpisodes.filter((e) => NO_ORDER_CAUSES.has(e.causeProposee)).length;

    const causeCounts = {};
    for (const e of bucket.openEpisodes) causeCounts[e.causeProposee] = (causeCounts[e.causeProposee] || 0) + 1;

    return {
      department: bucket.department,
      openCount: bucket.openEpisodes.length,
      totalEpisodesCount: bucket.openEpisodes.length + bucket.resolvedCount,
      avgDurationHours: Math.round(avgDurationHours * 10) / 10,
      longEpisodesCount,
      noOrderCount,
      causeCounts,
      totalCaPerduEstime: Math.round(bucket.totalCaPerdu),
    };
  });

  results.sort((a, b) => b.openCount - a.openCount);

  return {
    found: true,
    departmentCount: results.length,
    totalOpenAcrossDepartments: results.reduce((s, r) => s + r.openCount, 0),
    departments: results,
  };
}

// Historique des mouvements de stock/ventes affiché dans la fiche détail : fenêtre large pour
// couvrir tout l'épisode (même ancien) plus quelques jours avant son début (spec §3 : "quantités
// vendues avant la rupture").
const PRE_EPISODE_CONTEXT_DAYS = 14;

/**
 * Fiche détaillée d'un épisode de rupture (spec rupture.md §3-§5, 16/10/2026) : identité article,
 * mouvements de stock, ventes avant/pendant la rupture, commande associée avec sa chronologie
 * complète (création -> transmission -> réception, via ReceptionEvent), et les 3 délais distincts
 * demandés (§4 : réaction, réapprovisionnement, durée totale) — jamais additionnés entre eux,
 * affichés séparément comme le document l'exige explicitement.
 */
async function getEpisodeDetail(episodeId) {
  const episode = await prisma.stockoutEpisode.findUnique({ where: { id: episodeId } });
  if (!episode) return { found: false, message: 'Épisode de rupture introuvable.' };

  const now = new Date();
  const endedAt = episode.endedAt || now;
  const durationHours = Math.round(((endedAt.getTime() - episode.startedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;

  // Commande associée à CET épisode précis : contrairement à diagnoseCause (qui prend la dernière
  // proposition connue, utile pour un diagnostic rapide à la détection), on ne retient ici qu'une
  // commande créée À PARTIR du début de la rupture — une commande plus ancienne n'est pas une
  // réaction à cette rupture mais à une situation antérieure (bug trouvé en testant réellement :
  // un épisode du 16/10 se voyait associer une commande du 16/09, donnant un "délai de réaction"
  // négatif de -719h). Sans commande postérieure au début, order reste null (spec §4, scénario 1 :
  // "aucune commande n'a été identifiée").
  const candidateLines = await prisma.proposalLine.findMany({
    where: { ean: episode.ean, proposal: { rposShopId: episode.rposShopId, generatedAt: { gte: episode.startedAt } } },
    orderBy: { proposal: { generatedAt: 'asc' } },
    include: { proposal: true },
  });

  let order = null;
  let matchedLine = null;
  let receptionEvents = [];
  for (const line of candidateLines) {
    const candidateOrder = await prisma.proposalOrder.findFirst({
      where: { proposalId: line.proposalId, department: line.department || undefined, createdAt: { gte: episode.startedAt } },
      orderBy: { createdAt: 'asc' },
    });
    if (candidateOrder) {
      order = candidateOrder;
      matchedLine = line;
      break;
    }
  }
  if (order) {
    receptionEvents = await prisma.receptionEvent.findMany({
      where: { proposalOrderId: order.id },
      orderBy: { observedAt: 'asc' },
    });
  }

  // Les 3 délais distincts de la spec §4 — null si l'étape correspondante n'a pas (encore) de date.
  let reactionDelayHours = null;
  let replenishmentDelayHours = null;
  if (order) {
    reactionDelayHours = Math.round(((order.createdAt.getTime() - episode.startedAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;
    if (order.actualReceptionDate) {
      replenishmentDelayHours = Math.round(((order.actualReceptionDate.getTime() - order.createdAt.getTime()) / (60 * 60 * 1000)) * 10) / 10;
    }
  }

  const contextStart = new Date(episode.startedAt.getTime() - PRE_EPISODE_CONTEXT_DAYS * 24 * 60 * 60 * 1000);
  const [stockMoves, salesBefore, salesDuring] = await Promise.all([
    getMovesFromLocal(episode.rposShopId, episode.ean, contextStart, endedAt),
    prisma.salesLine.aggregate({
      where: { rposShopId: episode.rposShopId, ean: episode.ean, date: { gte: contextStart, lt: episode.startedAt } },
      _sum: { quantity: true, revenueExclTax: true },
      _count: true,
    }),
    prisma.salesLine.aggregate({
      where: { rposShopId: episode.rposShopId, ean: episode.ean, date: { gte: episode.startedAt, lte: endedAt } },
      _sum: { quantity: true, revenueExclTax: true },
    }),
  ]);

  return {
    found: true,
    id: episode.id,
    ean: episode.ean,
    label: episode.label,
    department: episode.department,
    rposShopId: episode.rposShopId,
    startedAt: episode.startedAt,
    endedAt: episode.endedAt,
    status: episode.status,
    durationHours,
    causeProposee: episode.causeProposee,
    niveauConfiance: episode.niveauConfiance,
    qtyPerdueEstimee: episode.qtyPerdueEstimee,
    caPerdueEstime: episode.caPerdueEstime,
    salesBeforeEpisode: {
      windowDays: PRE_EPISODE_CONTEXT_DAYS,
      quantity: salesBefore._sum.quantity || 0,
      revenue: salesBefore._sum.revenueExclTax || 0,
    },
    salesDuringEpisode: {
      quantity: salesDuring._sum.quantity || 0,
      revenue: salesDuring._sum.revenueExclTax || 0,
    },
    stockMoves,
    order: order
      ? {
          id: order.id,
          status: order.status,
          receptionStatus: order.receptionStatus,
          rposOrderValidated: order.rposOrderValidated,
          supplierName: order.supplierName,
          deliveryType: order.deliveryType,
          createdAt: order.createdAt,
          expectedReceptionDate: order.expectedReceptionDate,
          actualReceptionDate: order.actualReceptionDate,
          quantityOrdered: matchedLine?.quantityValidated ?? matchedLine?.quantitySuggested ?? null,
        }
      : null,
    receptionEvents: receptionEvents.map((e) => ({ observedAt: e.observedAt, receptionStatus: e.receptionStatus, rposStatus: e.rposStatus })),
    reactionDelayHours,
    replenishmentDelayHours,
    totalDurationHours: durationHours,
  };
}

/**
 * Évolution du nombre de ruptures en cours, jour par jour, sur les `days` derniers jours (demande
 * du 16/10/2026, drill-down magasin au même niveau de détail visuel que TableauDeBord.tsx : graphe
 * de tendance, pas juste un chiffre figé). Pour chaque jour, compte les épisodes qui étaient
 * EN_COURS à ce moment précis (startedAt <= jour ET (pas encore résolu OU résolu après ce jour)) —
 * calcul direct en JS plutôt qu'une requête SQL par jour (30 requêtes), un seul findMany suffit car
 * le nombre d'épisodes sur 30j + marge reste limité par magasin.
 */
async function getTrend(rposShopId, { days = 30 } = {}) {
  const now = new Date();
  const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // Tout épisode qui a pu être "en cours" à un moment de la fenêtre : commencé avant la fin de la
  // fenêtre, et (toujours ouvert OU résolu après le début de la fenêtre).
  const episodes = await prisma.stockoutEpisode.findMany({
    where: {
      rposShopId,
      startedAt: { lte: now },
      OR: [{ endedAt: null }, { endedAt: { gte: windowStart } }],
    },
    select: { startedAt: true, endedAt: true },
  });

  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const count = episodes.filter((e) => e.startedAt <= day && (!e.endedAt || e.endedAt > day)).length;
    points.push({ date: day.toISOString().slice(0, 10), openCount: count });
  }

  return { found: true, points };
}

module.exports = { detectStockoutEpisodes, getOpenEpisodes, getDashboardSummary, getDashboardSummaryAllShops, getDashboardSummaryByDepartment, getEpisodeDetail, getTrend };
