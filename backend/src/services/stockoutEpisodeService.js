/**
 * Détection et diagnostic des épisodes de rupture de stock, SANS les données Cyrus (entrepôt) —
 * cf. rupture.md. Le diagnostic est donc une version simplifiée de la grille §5 du document : on ne
 * peut pas distinguer "stock central indisponible" / "non préparé" / "retard transport", ces 3 cas
 * retombent tous sur AMONT_A_PRECISER.
 */
const prisma = require('../utils/prisma');

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

module.exports = { detectStockoutEpisodes, getOpenEpisodes, getDashboardSummary, getDashboardSummaryAllShops };
